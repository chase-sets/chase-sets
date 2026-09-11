import type { AggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import type { EventStoreError } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { deriveChannelListingId, type ChannelListingIdDigest } from "../domain/canonical";
import { composeChannelListingPublication } from "../domain/compose";
import type { ChannelCommandResult, ChannelCompositionProfileRegistry, ChannelListingEvent } from "../domain/contracts";
import { decideChannelListingComposition, type ChannelListingAggregateState } from "../domain/link";
import { parseChannelListingCompositionInput } from "../domain/parse";
import { readChannelListingCompositionFacts } from "../read-model/queries";

export type ChannelListingPublicationApplicationDeps = Readonly<{
  db: PgQueryable;
  profiles: ChannelCompositionProfileRegistry;
  listingIdDigest?: ChannelListingIdDigest;
  linkRepository: AggregateRepository<ChannelListingAggregateState, ChannelListingEvent>;
}>;

type ChannelListingDesiredStateDecision =
  | Readonly<{ kind: "append"; channelListingId: string; event: ChannelListingEvent }>
  | Readonly<{ kind: "unchanged"; channelListingId: string }>
  | Readonly<{ kind: "refused"; code: "unknown-link" }>;

export function createChannelListingPublicationApplication(deps: ChannelListingPublicationApplicationDeps): Readonly<{
  decideDesiredState(
    input: Readonly<{ connectionId: string; listingId: string }>,
    state: ChannelListingAggregateState,
    nextStreamVersion: number,
    db: PgQueryable,
  ): Promise<ChannelListingDesiredStateDecision>;
  recordDesiredState(
    input: Readonly<{ connectionId: string; listingId: string }>,
    context: EventStoreContext,
  ): Promise<ChannelCommandResult<Readonly<{ channelListingId: string }>>>;
}> {
  const decideDesiredState = async (
    input: Readonly<{ connectionId: string; listingId: string }>,
    state: ChannelListingAggregateState,
    nextStreamVersion: number,
    db: PgQueryable,
  ): Promise<ChannelListingDesiredStateDecision> => {
    const channelListingId = deriveChannelListingId(input.connectionId, input.listingId, deps.listingIdDigest);
    const facts = await readChannelListingCompositionFacts(db, input, deps.profiles);
    if (!facts) return { kind: "refused", code: "unknown-link" };
    const profile = deps.profiles.get({
      providerKey: facts.connection.providerKey,
      environment: facts.connection.environment,
    });
    const candidate = {
      ...facts,
      profile: profile ? { kind: "registered" as const, profile } : { kind: "unregistered" as const },
      link: state.exists ? { kind: "existing" as const, state: publicLinkState(state) } : { kind: "none" as const },
    };
    const parsed = parseChannelListingCompositionInput(candidate);
    if (parsed.kind === "invalid") {
      throw new Error(`Channel Listing Composition input rejected: ${parsed.programmingError}`);
    }
    const result = composeChannelListingPublication(parsed.input, deps.listingIdDigest);
    const listingRevision = parsed.input.listing.kind === "present" ? parsed.input.listing.listingRevision : 0;
    const decision = decideChannelListingComposition(state, {
      connectionId: input.connectionId,
      channelListingId,
      listingId: input.listingId,
      listingRevision,
      nextStreamVersion,
      result,
    });
    return decision.kind === "append"
      ? { kind: "append", channelListingId, event: decision.event }
      : { kind: "unchanged", channelListingId };
  };

  return {
    decideDesiredState,
    recordDesiredState: async (input, context) => {
      const channelListingId = deriveChannelListingId(input.connectionId, input.listingId, deps.listingIdDigest);
      const collision = await deps.db.query<{ connection_id: string; listing_id: string }>(
        `SELECT connection_id,listing_id FROM channels_channel_listing_links WHERE channel_listing_id=$1`,
        [channelListingId],
      );
      if (
        collision.rows[0] &&
        (collision.rows[0].connection_id !== input.connectionId || collision.rows[0].listing_id !== input.listingId)
      ) {
        return { kind: "refused", code: "channel-listing-id-collision" };
      }

      const loaded = await deps.linkRepository.load(linkStreamId(channelListingId));
      const decision = await decideDesiredState(input, loaded.state, loaded.version + 1, deps.db);
      if (decision.kind === "refused") return decision;
      if (decision.kind === "unchanged") {
        return { kind: "unchanged", value: { channelListingId }, streamVersion: loaded.version };
      }
      try {
        const stored = await deps.linkRepository.append({
          streamId: linkStreamId(channelListingId),
          expectedVersion: loaded.version === 0 ? "no_stream" : loaded.version,
          context,
          wakeSourceContextName: "channels",
          events: [decision.event],
        });
        return { kind: "applied", value: { channelListingId }, streamVersion: stored[0]!.streamVersion };
      } catch (error) {
        if (isConcurrencyConflict(error)) return { kind: "refused", code: "stream-version-conflict" };
        throw error;
      }
    },
  };
}

function publicLinkState(state: ChannelListingAggregateState) {
  return {
    connectionId: state.connectionId,
    channelListingId: state.channelListingId,
    listingId: state.listingId,
    externalListingId: state.externalListingId,
    externalOfferId: state.externalOfferId,
    providerRevision: state.providerRevision,
    lastDesiredStateSequence: state.lastDesiredStateSequence,
    lastDesiredListingRevision: state.lastDesiredListingRevision,
    lastDesiredStateHash: state.lastDesiredStateHash,
    lastDesiredIntent: state.lastDesiredIntent,
    lastPushedListingRevision: state.lastPushedListingRevision,
    lastPushedPriceAmountMinor: state.lastPushedPriceAmountMinor,
    lastPushedPriceCurrency: state.lastPushedPriceCurrency,
    lastPushedQuantity: state.lastPushedQuantity,
    publishState: state.publishState,
    blockingReasonCodes: state.blockingReasonCodes,
    failureReason: state.failureReason,
    driftStatus: state.driftStatus,
    lastStreamVersion: state.lastStreamVersion,
  };
}

function linkStreamId(channelListingId: string): string {
  return `channels.channel-listing-${channelListingId}`;
}

function isConcurrencyConflict(error: unknown): error is EventStoreError {
  return !!error && typeof error === "object" && "code" in error && error.code === "concurrency_conflict";
}
