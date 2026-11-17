import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresConfigurationEpochStore,
  createPostgresEventStore,
  initializeConfigurationConsumer,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { createRepricingConfigurationWriter, repricingHaltConfigurationKey } from "../api/configuration";
import { createRepricingPolicyRuntime } from "../api/runtime";
import { pricingRepricingPolicySchemaMigrations } from "../read-model/migrations";
import { dryRunContext } from "../../repricing-engine/tests/dry-run-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const accountId = "acc_configuration_10422";
const key = repricingHaltConfigurationKey(accountId);
const identity = { storeId: "synthetic-pricing-consumer-10422", incarnation: "synthetic-v1" };

describeDb("durable Pricing configuration requests", () => {
  let pools: Readonly<Record<"pricing" | "consumer", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["pricing", "consumer"],
      "synthetic_receipts_10422",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    for (const pool of Object.values(pools)) await pool.query(pricingModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools(pools));
  function epochs(available: boolean) {
    return createPostgresConfigurationEpochStore({
      pool: pools.pricing,
      sourceIncarnation: "pricing-repricing-configuration-v1",
      consumers: available ? [{ identity, pool: pools.consumer }] : [],
    });
  }
  function runtime(available = false) {
    const eventStore = createPostgresEventStore({ pool: pools.pricing });
    const configuration = createRepricingConfigurationWriter({
      pool: pools.pricing,
      eventStore,
      epochs: epochs(available),
    });
    return createRepricingPolicyRuntime({
      eventStore,
      db: pools.pricing,
      configuration,
      goalAdoptions: async () => [],
    });
  }
  async function enrolledHalt() {
    // Install through the production writer before enrolling a separate required store.
    const eventStore = createPostgresEventStore({ pool: pools.pricing });
    const configuration = createRepricingConfigurationWriter({ pool: pools.pricing, eventStore });
    const service = createRepricingPolicyRuntime({
      eventStore,
      db: pools.pricing,
      configuration,
      goalAdoptions: async () => [],
    });
    const installed = await service.setHalt(accountId, true, dryRunContext, "synthetic-engage");
    await initializeConfigurationConsumer(pools.consumer, identity);
    await epochs(true).registerConsumer(key, identity);
    return installed;
  }
  it("migrates idempotently and preserves installed halt through withheld-store restart, supersession and exact replay", async () => {
    const installed = await enrolledHalt();
    for (let repeat = 0; repeat < 2; repeat++)
      for (const statement of pricingRepricingPolicySchemaMigrations.find(
        (migration) => migration.migrationId === "20261117_pricing_configuration_receipts",
      )!.statements)
        await pools.pricing.query(statement);
    const pending = await runtime().setHalt(accountId, false, dryRunContext, "synthetic-release");
    expect(pending).toEqual({ status: "accepted-pending", requestedRevision: 2, requestKey: "synthetic-release" });
    expect(await runtime().getHalt(accountId)).toMatchObject({ engaged: true });
    expect(await runtime().getHaltConfigurationStatus(accountId)).toMatchObject({
      installedRevision: 1,
      requestedRevision: 2,
      request: pending,
    });
    expect(await runtime().setHalt(accountId, false, dryRunContext, "synthetic-release")).toEqual(pending);
    await expect(runtime().setHalt(accountId, true, dryRunContext, "synthetic-release")).rejects.toMatchObject({
      code: "concurrency_conflict",
    });
    await runtime().setHalt(accountId, true, dryRunContext, "synthetic-replacement");
    const superseded = {
      status: "superseded-by-revision",
      requestedRevision: 2,
      requestKey: "synthetic-release",
      replacingRevision: 3,
    };
    expect(await runtime(true).setHalt(accountId, false, dryRunContext, "synthetic-release")).toEqual(superseded);
    expect(await runtime(true).setHalt(accountId, true, dryRunContext, "synthetic-replacement")).toMatchObject({
      status: "applied",
      installedRevision: 3,
      state: { engaged: true },
    });
    expect(await runtime(true).setHalt(accountId, true, dryRunContext, "synthetic-engage")).toEqual(installed);
    expect(await runtime(true).setHalt(accountId, false, dryRunContext, "synthetic-release")).toEqual(superseded);
    const released = await runtime(true).setHalt(accountId, false, dryRunContext, "synthetic-final-release");
    expect(released).toMatchObject({ status: "applied", installedRevision: 4, state: { engaged: false } });
    expect(await runtime(true).setHalt(accountId, false, dryRunContext, "synthetic-final-release")).toEqual(released);
    expect(await runtime(true).getHalt(accountId)).toMatchObject({ engaged: false });
  });
  it("serializes identical requests, rejects changed commands and detects incomplete history after restart", async () => {
    await enrolledHalt();
    const requests = await Promise.all(
      Array.from({ length: 3 }, () => runtime().setHalt(accountId, false, dryRunContext, "synthetic-concurrent")),
    );
    expect(requests).toEqual([requests[0], requests[0], requests[0]]);
    expect(requests[0]).toMatchObject({ status: "accepted-pending", requestedRevision: 2 });
    expect(
      (
        await pools.pricing.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pricing_repricing_configuration_requests WHERE key = $1",
          [key],
        )
      ).rows[0]!.count,
    ).toBe("2");
    const applied = await runtime(true).setHalt(accountId, false, dryRunContext, "synthetic-concurrent");
    expect(applied.status).toBe("applied");
    await pools.pricing.query(
      "DELETE FROM pricing_repricing_configuration_requests WHERE key = $1 AND requested_revision = 1",
      [key],
    );
    await expect(runtime(true).getHaltConfigurationStatus(accountId)).rejects.toThrow(
      "Partial Pricing configuration history",
    );
    await expect(runtime(true).setHalt(accountId, false, dryRunContext, "synthetic-concurrent")).rejects.toThrow(
      "Partial Pricing configuration history",
    );
  });
  it("rolls installation back on append failure and retries the durable request without consuming a new revision", async () => {
    await enrolledHalt();
    await runtime().setHalt(accountId, false, dryRunContext, "synthetic-fault");
    const eventStore = createPostgresEventStore({ pool: pools.pricing });
    const configuration = createRepricingConfigurationWriter({
      pool: pools.pricing,
      epochs: epochs(true),
      eventStore: {
        appendToStreamInTransaction: async () => {
          throw new Error("synthetic append fault");
        },
      },
    });
    const faulty = createRepricingPolicyRuntime({
      eventStore,
      db: pools.pricing,
      configuration,
      goalAdoptions: async () => [],
    });
    await expect(faulty.setHalt(accountId, false, dryRunContext, "synthetic-fault")).rejects.toThrow(
      "synthetic append fault",
    );
    expect(await runtime().getHalt(accountId)).toMatchObject({ engaged: true });
    expect(await runtime().getHaltConfigurationStatus(accountId)).toMatchObject({
      installedRevision: 1,
      requestedRevision: 2,
      request: { status: "accepted-pending" },
    });
    expect(await runtime(true).setHalt(accountId, false, dryRunContext, "synthetic-fault")).toMatchObject({
      status: "applied",
      installedRevision: 2,
    });
  });
  it("a late driver returns its superseded receipt after a replacement has installed", async () => {
    await enrolledHalt();
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const source = epochs(true);
    const eventStore = createPostgresEventStore({ pool: pools.pricing });
    const configuration = createRepricingConfigurationWriter({
      pool: pools.pricing,
      eventStore,
      epochs: {
        ...source,
        driveClosure: async (closureKey) => {
          started();
          await held;
          return source.driveClosure(closureKey);
        },
      },
    });
    const slow = createRepricingPolicyRuntime({
      eventStore,
      db: pools.pricing,
      configuration,
      goalAdoptions: async () => [],
    });
    const late = slow.setHalt(accountId, false, dryRunContext, "synthetic-late-release");
    try {
      await entered;
      expect(await runtime(true).setHalt(accountId, true, dryRunContext, "synthetic-cutover")).toMatchObject({
        status: "applied",
        installedRevision: 3,
      });
    } finally {
      release();
    }
    expect(await late).toEqual({
      status: "superseded-by-revision",
      requestKey: "synthetic-late-release",
      requestedRevision: 2,
      replacingRevision: 3,
    });
    expect(await runtime(true).getHalt(accountId)).toMatchObject({ engaged: true });
    expect(
      (await eventStore.readAll()).filter((event) => event.eventType === "pricing.repricing-halt.released"),
    ).toHaveLength(0);
  });
});
