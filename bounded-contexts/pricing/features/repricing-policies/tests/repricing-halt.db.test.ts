import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { closeMultiContextTestPools, createMultiContextTestDatabaseUrls, createMultiContextTestPools, ensureMultiContextTestDatabases, resetMultiContextTestSchemas } from "@chase-sets/bounded-context-runtime/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { module as pricingModule } from "../../../index";
import { createRepricingPolicyRuntime } from "../api/runtime";
import { buildRepricingHaltProjectionHandlers } from "../read-model/halt-projection";
import { buildRepricingPolicyProjectionHandlers } from "../read-model/projection";
import { createRepricingEngineRuntime, type RepricingMarketplaceGateway } from "../../repricing-engine/api/runtime";
import { dryRunBody, dryRunContext, seedDryRunListings } from "../../repricing-engine/tests/dry-run-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("Repricing Halt steady-state lifecycle", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "synthetic_repricing_halt_7911");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => { await resetMultiContextTestSchemas(pools); await pools.pricing.query(pricingModule.schemaSql); });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("engage excludes, repeat emits nothing, release rejoins the next drift sweep without resuming an intended pause", async () => {
    const db = pools.pricing;
    const eventStore = createPostgresEventStore({ pool: db });
    const controls = createRepricingPolicyRuntime({ db, eventStore });
    const engine = createRepricingEngineRuntime({ db, eventStore });
    await seedDryRunListings(db, 2, 1);
    for (const [policyId, listingId, paused] of [
      ["rpp_synthetic_active", "lst_7910_00000001", false],
      ["rpp_synthetic_paused", "lst_7910_00000002", true],
    ] as const) {
      await controls.commandHandler({ streamId: controls.streamIdForPolicy(policyId), context: dryRunContext,
        command: { ...dryRunBody, scope: { kind: "listing-set", listingIds: [listingId] }, type: "CreateRepricingPolicy", policyId,
          accountId: "acc_7910", name: policyId, createdAt: new Date().toISOString() } });
      if (paused) await controls.executeOwnedRepricingPolicy({ accountId: "acc_7910", policyId, context: dryRunContext, command: { type: "PauseRepricingPolicy", pausedAt: new Date().toISOString() } });
    }
    const handlers = { ...buildRepricingPolicyProjectionHandlers(db), ...buildRepricingHaltProjectionHandlers(db) };
    const project = async () => { for (const event of await eventStore.readAll()) await handlers[event.eventType]?.(toTransportEvent(event)); };
    await project();
    expect(await controls.listRepricingPolicyAssignments({ accountId: "acc_7910" })).toHaveLength(1);
    expect(await controls.getHalt("acc_7910")).toMatchObject({ engaged: false });
    await controls.setHalt("acc_7910", true, dryRunContext);
    const eventsBeforeRepeat = await eventStore.readAll();
    await controls.setHalt("acc_7910", true, dryRunContext);
    expect(await eventStore.readAll()).toEqual(eventsBeforeRepeat);
    await project();
    expect(await controls.listRepricingPolicyAssignments({ accountId: "acc_7910" })).toEqual([]);
    expect(await engine.enqueueDailyDriftSweep({ now: "2026-09-14T12:00:00Z", limit: 10 })).toBe(0);
    await controls.setHalt("acc_7910", false, dryRunContext);
    await project();
    expect(await controls.listRepricingPolicyAssignments({ accountId: "acc_7910" })).toEqual([expect.objectContaining({ policyId: "rpp_synthetic_active" })]);
    expect((await controls.loadOwnedRepricingPolicy("rpp_synthetic_paused", "acc_7910"))?.state.status).toBe("paused");
    expect(await engine.enqueueDailyDriftSweep({ now: "2026-09-15T12:00:00Z", limit: 10 })).toBe(1);
    const apply = vi.fn<RepricingMarketplaceGateway["applyBulkListingPriceUpdates"]>(async ({ updates }) => ({ items: updates.map(({ listingId }) => ({ listingId, outcome: "applied" })) }));
    const gateway: RepricingMarketplaceGateway = { applyBulkListingPriceUpdates: apply, pauseListing: vi.fn(), publishListing: vi.fn() };
    expect(await engine.processNextEvaluationJob({ claimOwnerId: "synthetic_7911", claimTtlMs: 30_000, marketplaceGatewayForAccount: () => gateway })).toBe(1);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]![0].updates.map(({ listingId }) => listingId)).toEqual(["lst_7910_00000001"]);
    const haltEvents = (await eventStore.readAll()).filter((event) => event.eventType.startsWith("pricing.repricing-halt."));
    expect(haltEvents.map(({ eventType }) => eventType)).toEqual(["pricing.repricing-halt.engaged", "pricing.repricing-halt.released"]);
    expect(haltEvents.every(({ performedByUserId, forAccountId }) => performedByUserId === dryRunContext.audit.performedByUserId && forAccountId === "acc_7910")).toBe(true);
    await handlers[haltEvents[0]!.eventType]!(toTransportEvent(haltEvents[0]!));
    expect((await db.query<{ engaged: boolean }>("SELECT engaged FROM pricing_repricing_halts WHERE seller_account_id = 'acc_7910'")).rows).toEqual([{ engaged: false }]);
    expect(await controls.getHalt("acc_foreign")).toMatchObject({ engaged: false });
  });
});
