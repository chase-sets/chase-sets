import { describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { composeChannelListingPublication } from "../../listing-composition/domain/compose";
import { assertChannelListingDelistDirective } from "../../listing-composition/domain/codecs";
import { listingInput, publishedLink } from "../../listing-composition/tests/test-support";
import type { ChannelProviderRegistry } from "../../publication-port/domain/contracts";
import { createOutboundSyncRuntime } from "../api/runtime";
import type { mapOutboundOperationRow } from "../api/store";

describe("low-stock publication routing", () => {
  it.each([
    ["withheld new", true, false, null],
    ["withheld published", true, true, "delist"],
    ["recovered retained", false, true, "update"],
    ["new above threshold", false, false, "publish"],
  ] as const)("routes %s through the real inline dispatcher", async (_label, withheld, retained, expected) => {
    const base = listingInput({ link: retained ? { kind: "existing", state: publishedLink() } : { kind: "none" } });
    if (base.listing.kind !== "present") throw new Error("Expected listing.");
    const result = composeChannelListingPublication({
      ...base,
      listing: {
        ...base.listing,
        offer: {
          ...base.listing.offer,
          publishableQuantity: withheld ? { kind: "low-stock-withheld" } : { kind: "resolved", value: 3 },
        },
      },
    });
    const succeeded = async () => ({ kind: "succeeded" as const, externalListingId: "synthetic-external" });
    const publishListing = vi.fn(succeeded);
    const updatePriceQuantity = vi.fn(succeeded);
    const delistListing = vi.fn(succeeded);
    const identity = { providerKey: "synthetic-provider", environment: "sandbox" as const };
    const registry: ChannelProviderRegistry = {
      list: () => [identity],
      get: () => ({
        identity,
        setup: {
          ...identity,
          requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
        },
        publication: {
          execution: "inline",
          publishListing,
          updatePriceQuantity,
          delistListing,
          fetchChannelState: async () => {
            throw new Error("No observation expected.");
          },
          fetchSales: async () => {
            throw new Error("No sale fetch expected.");
          },
        },
      }),
    };
    const now = "2026-10-08T00:00:00.000Z";
    type Row = Parameters<typeof mapOutboundOperationRow>[0];
    let row: Row | null =
      result.kind === "blocked"
        ? null
        : {
            operation_id: "synthetic-operation",
            connection_id: "connection-synthetic",
            channel_listing_id:
              result.intent === "delist" ? result.delist.channelListingId : result.draft.channelListingId,
            listing_id: "listing-synthetic",
            operation_kind: result.intent,
            operation_origin: "desired-state",
            listing_revision: 7,
            source_desired_state_sequence: 3,
            payload:
              result.intent === "delist"
                ? { kind: "delist", delist: result.delist }
                : { kind: "draft", draft: result.draft },
            payload_digest: "a".repeat(64),
            status: "pending",
            revision: 1,
            attempt_id: null,
            claim_generation: 0,
            claimant_kind: null,
            claim_owner_id: null,
            reservation_id: null,
            claimed_until: null,
            attempt_count: 0,
            next_attempt_at: now,
            last_rejection_code: null,
            terminal_reason: null,
            link_write_state: "pending",
            source_event_id: "synthetic-event",
            source_stream_id: "synthetic-stream",
            source_stream_version: 3,
            source_global_position: "3",
            source_desired_state_hash: result.desiredStateHash,
            source_occurred_at: now,
            enqueued_at: now,
            first_claimed_at: null,
            terminal_at: null,
          };
    // Synthetic persistence responses isolate dispatcher behavior, not PostgreSQL or provider acceptance.
    const query: PgTransactionalPool["query"] = async <T>(sql: string, values: readonly unknown[] = []) => {
      let rows: unknown[] = [];
      if (sql.includes("WITH connection_load"))
        rows =
          row?.status === "pending"
            ? [
                {
                  ...row,
                  provider_key: identity.providerKey,
                  environment: identity.environment,
                  connection_status: "active",
                },
              ]
            : [];
      else if (sql.includes("SELECT provider_key, environment, window_started_at"))
        rows = [
          {
            provider_key: identity.providerKey,
            environment: identity.environment,
            window_started_at: now,
            request_count: 0,
            adaptive_divisor: 1,
            throttled_until: null,
            consecutive_successes: 0,
            last_rate_limit_at: null,
            revision: "1",
          },
        ];
      else if (sql.includes("SET status = 'in-flight'")) {
        if (!row) throw new Error("Expected pending operation.");
        row = {
          ...row,
          status: "in-flight",
          revision: 2,
          attempt_id: String(values[1]),
          claim_generation: 1,
          claimant_kind: "inline",
          claim_owner_id: "synthetic-worker",
          claimed_until: String(values[3]),
          first_claimed_at: now,
        };
        rows = [row];
      } else if (sql.includes("operation_id = ANY")) rows = row ? [row] : [];
      else if (sql.includes("SET status = 'succeeded'")) {
        if (!row) throw new Error("Expected claimed operation.");
        row = { ...row, status: "succeeded" };
      } else if (sql.includes("SELECT count(*)::integer AS active")) rows = [{ active: 0 }];
      else if (
        !/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql) &&
        !sql.includes("INSERT INTO channel_provider_rate_state") &&
        !sql.includes("UPDATE channel_provider_rate_state")
      ) {
        throw new Error(`Unexpected synthetic query: ${sql.slice(0, 80)}`);
      }
      return { rows: rows as T[], rowCount: 1 };
    };
    const db: PgTransactionalPool = { query, connect: async () => ({ query, release: () => undefined }) };
    const recordOutcome = vi.fn(async () => "applied" as const);
    const runtime = createOutboundSyncRuntime(
      {
        db,
        clock: { now: () => new Date(now) },
        recordOutcome,
        readAdditionalOutboundHold: async () => ({ held: false, sources: [] }),
      },
      { assertDelistDirective: assertChannelListingDelistDirective },
    );
    expect(await runtime.processNextInlineOperation({ registry, claimOwnerId: "synthetic-worker" })).toBe(
      expected === null ? 0 : 1,
    );
    expect(publishListing).toHaveBeenCalledTimes(expected === "publish" ? 1 : 0);
    expect(updatePriceQuantity).toHaveBeenCalledTimes(expected === "update" ? 1 : 0);
    expect(delistListing).toHaveBeenCalledTimes(expected === "delist" ? 1 : 0);
    expect(recordOutcome).toHaveBeenCalledTimes(expected === null ? 0 : 1);
    expect(await runtime.processNextInlineOperation({ registry, claimOwnerId: "synthetic-worker" })).toBe(0);
  });
});
