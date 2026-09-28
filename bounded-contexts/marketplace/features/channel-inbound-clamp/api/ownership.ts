import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ListingAuthorityOperation } from "@chase-sets/event-core/listing-authority";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createListingAuthorityFence } from "@chase-sets/platform-runtime/listing-authority-fence";
import type { MarketplaceListingServices } from "../../listings/api/runtime";
import { resumeListingSchema } from "../../listings/api/target-validation";

type Owner = Readonly<{ accountId: string; listingId: string; connectionId: string; runId: string }>;
type Listings = Pick<MarketplaceListingServices, "commandHandler" | "loadListingState" | "resumeListing">;

/** The SQL clamp table discovers work. Only the Listing history owns its pause and release. */
export function createListingInboundClampOwnership(
  deps: Readonly<{ eventStore: EventStore; db: PgQueryable; listings: Listings }>,
) {
  async function current(input: Owner, context: EventStoreContext) {
    let state = await deps.listings.loadListingState(input.listingId);
    if (state.accountId !== input.accountId || context.audit.forAccountId !== input.accountId)
      throw new Error("Listing clamp account authority mismatch.");
    if (state.status === "paused" && state.pauseReason === "channel-inbound-dark" && !state.inboundClampOwners.length) {
      const retained = await deps.db.query<{
        connection_id: string;
        run_id: string;
        paused_stream_version: string | number;
      }>(
        `
        SELECT connection_id, run_id, paused_stream_version FROM marketplace_channel_inbound_clamps
        WHERE account_id=$1 AND listing_id=$2 AND state='engaged' ORDER BY connection_id,run_id LIMIT 129`,
        [input.accountId, input.listingId],
      );
      if (
        !retained.rows.length ||
        retained.rows.length > 128 ||
        retained.rows.some((row) => Number(row.paused_stream_version) !== state.streamRevision)
      )
        throw new Error("Legacy inbound clamp ownership is incomplete or changed.");
      const previousRevision = state.streamRevision;
      const result = await deps.listings.commandHandler({
        streamId: `marketplace.listing-${input.listingId}`,
        expectedVersion: previousRevision,
        context,
        command: {
          type: "AdoptListingInboundClampOwners",
          owners: retained.rows.map((row) => ({ connectionId: row.connection_id, runId: row.run_id })),
        },
      });
      state = result.state;
    }
    const history = await readCompleteStream(deps.eventStore, { streamId: `marketplace.listing-${input.listingId}` });
    const released = history.find(
      (event) =>
        event.eventType === "marketplace.listing.inbound-clamp-released" &&
        event.payload.connectionId === input.connectionId &&
        event.payload.runId === input.runId,
    );
    const engaged = history.some(
      (event) =>
        (event.eventType === "marketplace.listing.inbound-clamp-engaged" &&
          event.payload.connectionId === input.connectionId &&
          event.payload.runId === input.runId) ||
        (event.eventType === "marketplace.listing.inbound-clamp-ownership-adopted" &&
          Array.isArray(event.payload.owners) &&
          event.payload.owners.some(
            (value) =>
              value &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              value.connectionId === input.connectionId &&
              value.runId === input.runId,
          )),
    );
    return {
      state,
      released,
      engaged,
      retained: released
        ? history.find((event) => event.streamVersion === released.streamVersion + 1)?.eventType !==
          "marketplace.listing.resumed"
        : false,
    };
  }
  return {
    async engage(input: Owner, context: EventStoreContext) {
      const { state, released, engaged } = await current(input, context);
      if (released) throw new Error("A released inbound clamp run cannot be reused.");
      if (
        engaged &&
        !state.inboundClampOwners.some(
          (owner) => owner.connectionId === input.connectionId && owner.runId === input.runId,
        )
      )
        throw new Error("Inbound clamp run was superseded by a newer pause owner.");
      const result = await deps.listings.commandHandler({
        streamId: `marketplace.listing-${input.listingId}`,
        expectedVersion: state.streamRevision,
        context,
        command: { type: "EngageListingInboundClamp", connectionId: input.connectionId, runId: input.runId },
      });
      const owner = result.state.inboundClampOwners.find(
        (entry) => entry.connectionId === input.connectionId && entry.runId === input.runId,
      );
      if (!owner) throw new Error("Inbound clamp engagement lost its source owner.");
      return { version: result.version, generation: owner.generation };
    },
    async release(input: Owner, context: EventStoreContext) {
      let read = await current(input, context);
      if (read.released) return { retained: read.retained, version: read.released.streamVersion };
      const owner = read.state.inboundClampOwners.find(
        (entry) => entry.connectionId === input.connectionId && entry.runId === input.runId,
      );
      if (!owner)
        throw new Error("Inbound clamp has no authoritative Listing owner; legacy reconciliation is required.");
      // Resolve any earlier executor before minting a new request. Unknown outcomes retain ownership.
      const previous = await deps.db.query<{ operation: ListingAuthorityOperation }>(
        `
        SELECT payload->'operation' AS operation FROM event_store_events
        WHERE event_type='marketplace.listing-authority-operation.opened' AND tenant_id=$1
          AND payload->'operation'->>'accountId'=$2 AND payload->'operation'->>'listingId'=$3
          AND payload->'operation'->>'kind'='resume'
          AND payload->'operation'->'command'->'inboundClamp'->>'connectionId'=$4
          AND payload->'operation'->'command'->'inboundClamp'->>'runId'=$5
          AND payload->'operation'->'command'->'inboundClamp'->>'generation'=$6
        ORDER BY global_position DESC LIMIT 1`,
        [context.tenantId, input.accountId, input.listingId, input.connectionId, input.runId, String(owner.generation)],
      );
      const prior = previous.rows[0]?.operation;
      if (prior) {
        const parsed = resumeListingSchema.shape.inboundClamp.safeParse(prior.command.inboundClamp);
        const binding = parsed.success ? parsed.data : undefined;
        if (
          prior.kind !== "resume" ||
          prior.tenantId !== context.tenantId ||
          prior.accountId !== input.accountId ||
          prior.listingId !== input.listingId ||
          !binding ||
          binding.connectionId !== owner.connectionId ||
          binding.runId !== owner.runId ||
          binding.generation !== owner.generation
        )
          throw new Error("Clamp recovery operation binding is corrupt.");
        const terminal = await createListingAuthorityFence({
          eventStore: deps.eventStore,
          owner: "marketplace",
          participants: [],
        }).abort(prior, "inbound-clamp-recovery");
        read = await current(input, context);
        if (terminal.status === "committed") {
          if (!read.released) throw new Error("Committed clamp recovery lost its release history.");
          return { retained: read.retained, version: read.released.streamVersion };
        }
      }
      if (read.state.inboundClampOwners.length > 1) {
        const result = await deps.listings.commandHandler({
          streamId: `marketplace.listing-${input.listingId}`,
          expectedVersion: read.state.streamRevision,
          context,
          command: { type: "ReleaseListingInboundClamp", owner },
        });
        return { retained: true, version: result.version };
      }
      const idempotencyKey = `clamp-resume:${createHash("sha256")
        .update(JSON.stringify([input, owner.generation, read.state.streamRevision, prior?.operationId ?? null]))
        .digest("hex")}`;
      const result = await deps.listings.resumeListing(
        {
          accountId: input.accountId,
          listingId: input.listingId,
          expectedListingVersion: read.state.streamRevision,
          expectedPauseReason: "channel-inbound-dark",
          inboundClamp: owner,
          idempotencyKey,
        },
        context,
      );
      return { retained: false, version: result.version };
    },
  };
}
