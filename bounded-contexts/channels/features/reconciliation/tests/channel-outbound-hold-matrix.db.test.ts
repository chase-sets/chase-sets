import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { parseGlobalPosition, type EventStoreContext } from "@chase-sets/event-core/storage";
import { module as channelsModule } from "../../../index";
import { createOutboundSyncRuntime } from "../../outbound-sync/api/runtime";
import { createChannelProviderRegistry } from "../../publication-port/api/registry";
import type { ChannelProviderDescriptor } from "../../publication-port/domain/contracts";
import { createChannelReconciliationRuntime } from "../api/runtime";
import { CHANNEL_RECONCILIATION_POLICY_FALLBACK } from "../domain/policy";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;
const combinations = Array.from({ length: 8 }, (_, mask) => ({
  seller: Boolean(mask & 1),
  health: Boolean(mask & 2),
  operator: Boolean(mask & 4),
}));

describeDb("channel-outbound-hold-matrix at real outbound admission", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "channel_outbound_hold_matrix");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it.each(combinations)(
    "keeps inline work pending for seller=$seller health=$health operator=$operator",
    async ({ seller, health, operator }) => {
      await insertConnection(pools.channels, "connection-inline", "inline-provider", seller);
      const providerCall = vi.fn(async () => ({ kind: "succeeded" as const, externalListingId: "external-1" }));
      const runtime = createOutboundSyncRuntime(
        {
          db: pools.channels,
          recordOutcome: async () => "applied",
          readAdditionalOutboundHold: async () => ({
            held: health || operator,
            sources: [...(health ? (["health"] as const) : []), ...(operator ? (["operator-kill"] as const) : [])],
          }),
        },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState(desiredState("connection-inline"));
      const processed = await runtime.processNextInlineOperation({
        registry: registry("inline-provider", {
          execution: "inline",
          publishListing: providerCall,
          updatePriceQuantity: providerCall,
          delistListing: providerCall,
          fetchChannelState: async () => ({
            kind: "complete",
            items: [],
            collectedCount: 0,
            authorityTotal: 0,
            pageCount: 1,
          }),
          fetchSales: async () => ({ kind: "complete", lines: [], collectedCount: 0, authorityTotal: 0, pageCount: 1 }),
        }),
        claimOwnerId: "hold-matrix-inline",
      });
      const held = seller || health || operator;
      expect(processed).toBe(held ? 0 : 1);
      expect(providerCall).toHaveBeenCalledTimes(held ? 0 : 1);
      await expect(operationState(pools.channels)).resolves.toEqual(
        held ? { status: "pending", attempt_count: 0 } : { status: "succeeded", attempt_count: 1 },
      );
    },
  );

  it.each(combinations)(
    "keeps claimed work pending for seller=$seller health=$health operator=$operator",
    async ({ seller, health, operator }) => {
      await insertConnection(pools.channels, "connection-claimed", "claimed-provider", seller);
      const runtime = createOutboundSyncRuntime(
        {
          db: pools.channels,
          recordOutcome: async () => "applied",
          readAdditionalOutboundHold: async () => ({
            held: health || operator,
            sources: [...(health ? (["health"] as const) : []), ...(operator ? (["operator-kill"] as const) : [])],
          }),
        },
        { assertDelistDirective: () => undefined },
      );
      await runtime.enqueueDesiredState(desiredState("connection-claimed"));
      const held = seller || health || operator;
      if (seller) {
        await expect(
          runtime.reserveClaimedOutboundOperations({
            registry: registry("claimed-provider", { execution: "claimed" }),
            connectionId: "connection-claimed",
            claimant: { claimantKind: "manual", claimantId: "hold-matrix-claimed" },
            maxOperations: 1,
            leaseMs: 60_000,
          }),
        ).rejects.toMatchObject({ code: "connection-not-active" });
      } else {
        const reservation = await runtime.reserveClaimedOutboundOperations({
          registry: registry("claimed-provider", { execution: "claimed" }),
          connectionId: "connection-claimed",
          claimant: { claimantKind: "manual", claimantId: "hold-matrix-claimed" },
          maxOperations: 1,
          leaseMs: 60_000,
        });
        expect(reservation === null).toBe(held);
      }
      await expect(operationState(pools.channels)).resolves.toEqual(
        held ? { status: "pending", attempt_count: 0 } : { status: "in-flight", attempt_count: 1 },
      );
    },
  );

  it.each(combinations)(
    "gates reconciliation fetch for seller=$seller health=$health operator=$operator",
    async ({ seller, health, operator }) => {
      await insertConnection(pools.channels, "connection-reconciliation", "inline-provider", seller);
      const fetchChannelState = vi.fn(async () => ({
        kind: "complete" as const,
        items: [],
        collectedCount: 0,
        authorityTotal: 0,
        pageCount: 1,
      }));
      const fetchSales = vi.fn(async () => ({
        kind: "complete" as const,
        lines: [],
        collectedCount: 0,
        authorityTotal: 0,
        pageCount: 1,
      }));
      const runtime = createChannelReconciliationRuntime({
        db: pools.channels,
        eventStore: createPostgresEventStore({ pool: pools.channels }),
        outboundSync: {
          enqueueReconciliationRepair: async () => null,
          enqueueRepush: async () => null,
          readOutboundOperationsByIds: async () => [],
        },
        channelSaleRecorder: async () => ({
          code: "external-channel-sale-history-invalid",
          saleStreamId: "unused",
          reason: "empty-existing-stream",
          eventIndex: null,
        }),
        resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
        resolveKillSwitch: async () => ({
          heldProviderKeys: operator ? ["inline-provider"] : [],
          heldConnectionIds: [],
        }),
        readHealthHold: async () => health,
      });
      const result = await runtime.reconcileConnection(
        {
          connectionId: "connection-reconciliation",
          registry: registry("inline-provider", {
            execution: "inline",
            publishListing: async () => ({ kind: "succeeded", externalListingId: "unused" }),
            updatePriceQuantity: async () => ({ kind: "succeeded", externalListingId: "unused" }),
            delistListing: async () => ({ kind: "succeeded", externalListingId: "unused" }),
            fetchChannelState,
            fetchSales,
          }),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        reconciliationContext,
      );
      const held = seller || health || operator;
      expect(result.state).toBe(held ? "held" : "completed");
      expect(fetchChannelState).toHaveBeenCalledTimes(held ? 0 : 1);
      expect(fetchSales).toHaveBeenCalledTimes(held ? 0 : 1);
    },
  );
});

const reconciliationContext: EventStoreContext = {
  tenantId: "tnt_hold_matrix" as never,
  audit: { performedByUserId: "usr_hold_matrix" as never, forAccountId: "account-1" as never },
};

function registry(providerKey: string, publication: NonNullable<ChannelProviderDescriptor["publication"]>) {
  return createChannelProviderRegistry([
    {
      identity: { providerKey, environment: "sandbox" },
      setup: {
        providerKey,
        environment: "sandbox",
        requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
      },
      publication,
    },
  ]);
}

async function insertConnection(db: PgTransactionalPool, connectionId: string, providerKey: string, paused: boolean) {
  await db.query(
    `INSERT INTO channel_connections
       (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
     VALUES ($1,'account-1',$2,'sandbox',$3,'2026-09-12T05:00:00.000Z','2026-09-12T05:00:00.000Z','[]'::jsonb,now(),1)`,
    [connectionId, providerKey, paused ? "paused" : "active"],
  );
}

function desiredState(connectionId: string) {
  return {
    connectionId,
    channelListingId: "channel-listing-1",
    listingId: "listing-1",
    operationKind: "publish" as const,
    listingRevision: 1,
    desiredStateSequence: 1,
    desiredStateHash: "1".repeat(64),
    payload: {
      kind: "draft" as const,
      draft: {
        channelListingId: "channel-listing-1",
        listingRevision: 1,
        title: "Synthetic",
        description: "Synthetic hold matrix",
        categoryKey: "category",
        conditionKey: "condition",
        price: { amountMinor: 1_000, currency: "USD" },
        quantity: 1,
        attributes: [],
      },
    },
    envelope: {
      sourceEventId: "event-1",
      sourceStreamId: "channels.channel-listing-channel-listing-1",
      sourceStreamVersion: 1,
      sourceGlobalPosition: parseGlobalPosition("1"),
      sourceOccurredAt: "2026-09-12T05:00:00.000Z",
    },
  };
}

async function operationState(db: PgTransactionalPool) {
  const result = await db.query<{ status: string; attempt_count: number }>(
    `SELECT status,attempt_count FROM channel_outbound_operations LIMIT 1`,
  );
  return { status: result.rows[0]!.status, attempt_count: Number(result.rows[0]!.attempt_count) };
}
