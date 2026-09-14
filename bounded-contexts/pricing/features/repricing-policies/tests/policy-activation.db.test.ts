import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresEventStore,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { module as pricingModule } from "../../../index";
import { createRepricingPolicyActivationServices, DryRunRequiredError } from "../api/activation";
import { createRepricingPolicyRuntime } from "../api/runtime";
import { createRepricingEngineRuntime } from "../../repricing-engine/api/runtime";
import { hashRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import { dryRunBody, dryRunContext } from "../../repricing-engine/tests/dry-run-fixture";
import { buildRepricingPolicyProjectionHandlers } from "../read-model/projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const accountId = "acc_7910";

describeDb("policy first activation", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "synthetic_policy_activation_7911");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  function services(eventStore = createPostgresEventStore({ pool: pools.pricing }), pool = pools.pricing) {
    return {
      ...createRepricingPolicyRuntime({ eventStore, db: pool }),
      ...createRepricingPolicyActivationServices({ eventStore, pool }),
    };
  }
  async function completedRun() {
    const engine = createRepricingEngineRuntime({
      eventStore: createPostgresEventStore({ pool: pools.pricing }),
      db: pools.pricing,
    });
    const run = await engine.enqueueDryRun({ sellerAccountId: accountId, body: dryRunBody }, dryRunContext);
    expect(await engine.processNextDryRunJob({ claimOwnerId: "synthetic_7911", claimTtlMs: 30_000 })).toBe(1);
    expect((await engine.getDryRun(accountId, run!.dryRunId))?.status).toBe("completed");
    return run!.dryRunId;
  }
  const activateInput = (dryRunId: string) => ({ accountId, dryRunId, name: "Synthetic activation" });
  async function createdEvents() {
    return (await createPostgresEventStore({ pool: pools.pricing }).readAll()).filter(
      (event) => event.eventType === "pricing.repricing-policy.created",
    );
  }

  it("creates from the exact stored body indefinitely and owns commands before projection catchup", async () => {
    const dryRunId = await completedRun();
    await pools.pricing.query(
      "UPDATE pricing_repricing_dry_runs SET completed_at = '2000-01-01' WHERE dry_run_id = $1 AND consumed_at IS NULL",
      [dryRunId],
    );
    const controls = services();
    const state = await controls.activateRepricingPolicy(activateInput(dryRunId), dryRunContext);
    expect(state).toMatchObject({ ...dryRunBody, accountId, status: "active", name: "Synthetic activation" });
    const policyId = state!.policyId!;
    expect(await controls.getAccountRepricingPolicy({ accountId, policyId })).toBeNull();
    expect(await controls.loadOwnedRepricingPolicy(policyId, "acc_foreign")).toBeNull();
    expect(
      await controls.executeOwnedRepricingPolicy({
        accountId: "acc_foreign",
        policyId,
        command: { type: "DeleteRepricingPolicy", deletedAt: new Date().toISOString() },
        context: dryRunContext,
      }),
    ).toBeNull();
    expect(
      await controls.executeOwnedRepricingPolicy({
        accountId,
        policyId,
        command: { type: "PauseRepricingPolicy", pausedAt: new Date().toISOString() },
        context: dryRunContext,
      }),
    ).toMatchObject({ status: "paused" });
    const projected = buildRepricingPolicyProjectionHandlers(pools.pricing);
    for (const event of await createPostgresEventStore({ pool: pools.pricing }).readAll())
      await projected[event.eventType]?.(toTransportEvent(event));
    expect(await controls.getAccountRepricingPolicy({ accountId, policyId })).toMatchObject({
      policyId,
      status: "paused",
    });
    expect(await controls.getAccountRepricingPolicy({ accountId: "acc_foreign", policyId })).toBeNull();
    expect(await controls.getAccountRepricingPolicy({ accountId, policyId: "rpp_missing" })).toBeNull();
    expect(await createdEvents()).toHaveLength(1);
    await expect(controls.activateRepricingPolicy(activateInput(dryRunId), dryRunContext)).rejects.toBeInstanceOf(
      DryRunRequiredError,
    );
  });

  it.each(["queued", "failed", "consumed", "mismatched", "invalid-body"])(
    "rejects %s runs without an event or consumption",
    async (invalid) => {
      const dryRunId = await completedRun();
      if (invalid === "invalid-body") {
        const invalidBody = { ...dryRunBody, maxChangesPerDay: 0 };
        await pools.pricing.query(
          "UPDATE pricing_repricing_dry_runs SET body = $2::jsonb, body_hash = $3 WHERE dry_run_id = $1 AND consumed_at IS NULL",
          [dryRunId, JSON.stringify(invalidBody), hashRepricingDryRunBody(invalidBody)],
        );
      } else if (invalid === "mismatched")
        await pools.pricing.query(
          "UPDATE pricing_repricing_dry_runs SET body_hash = 'synthetic_wrong_hash' WHERE dry_run_id = $1 AND consumed_at IS NULL",
          [dryRunId],
        );
      else if (invalid === "consumed")
        await pools.pricing.query(
          "UPDATE pricing_repricing_dry_runs SET consumed_at = now() WHERE dry_run_id = $1 AND consumed_at IS NULL",
          [dryRunId],
        );
      else if (invalid === "queued")
        await pools.pricing.query(
          "UPDATE pricing_repricing_dry_runs SET status = 'queued' WHERE dry_run_id = $1 AND status = 'completed'",
          [dryRunId],
        );
      else
        await pools.pricing.query(
          "UPDATE pricing_repricing_dry_run_jobs SET status = 'failed' WHERE job_id = $1 AND status = 'completed'",
          [dryRunId],
        );
      await expect(services().activateRepricingPolicy(activateInput(dryRunId), dryRunContext)).rejects.toBeInstanceOf(
        DryRunRequiredError,
      );
      expect(await createdEvents()).toHaveLength(0);
      const row = (
        await pools.pricing.query<{ consumed: boolean }>(
          "SELECT consumed_at IS NOT NULL AS consumed FROM pricing_repricing_dry_runs WHERE dry_run_id = $1",
          [dryRunId],
        )
      ).rows[0];
      expect(row?.consumed).toBe(invalid === "consumed");
    },
  );

  it("rejects a genuinely cancelled dry-run worker without consuming its request", async () => {
    const engine = createRepricingEngineRuntime({
      eventStore: createPostgresEventStore({ pool: pools.pricing }),
      db: pools.pricing,
    });
    const run = await engine.enqueueDryRun({ sellerAccountId: accountId, body: dryRunBody }, dryRunContext);
    await expect(
      engine.processNextDryRunJob({
        claimOwnerId: "synthetic_cancelled_7911",
        claimTtlMs: 30_000,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("cancelled");
    await expect(
      services().activateRepricingPolicy(activateInput(run!.dryRunId), dryRunContext),
    ).rejects.toBeInstanceOf(DryRunRequiredError);
    expect(await createdEvents()).toHaveLength(0);
    expect((await engine.getDryRun(accountId, run!.dryRunId))?.consumedAt).toBeNull();
  });

  it("foreign and absent dry runs are indistinguishable and do not consume", async () => {
    const dryRunId = await completedRun();
    expect(
      await services().activateRepricingPolicy({ ...activateInput(dryRunId), accountId: "acc_foreign" }, dryRunContext),
    ).toBeNull();
    expect(await services().activateRepricingPolicy(activateInput("synthetic_missing"), dryRunContext)).toBeNull();
    expect(await createdEvents()).toHaveLength(0);
    expect(await services().activateRepricingPolicy(activateInput(dryRunId), dryRunContext)).not.toBeNull();
  });

  it("holds concurrent consumption until winner commit and permits exactly one activation", async () => {
    const dryRunId = await completedRun();
    const store = createPostgresEventStore({ pool: pools.pricing });
    let reached!: () => void;
    let release!: () => void;
    const atAppend = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldStore: PostgresEventStore = {
      ...store,
      appendToStreamInTransaction: async (client, input) => {
        reached();
        await barrier;
        return store.appendToStreamInTransaction(client, input);
      },
    };
    const winner = services(heldStore).activateRepricingPolicy(activateInput(dryRunId), dryRunContext);
    let loser: ReturnType<ReturnType<typeof services>["activateRepricingPolicy"]> | undefined;
    try {
      await atAppend;
      let loserSettled = false;
      let reachedConsumption!: () => void;
      const atConsumption = new Promise<void>((resolve) => {
        reachedConsumption = resolve;
      });
      const observedPool: PgTransactionalPool = {
        query: pools.pricing.query.bind(pools.pricing),
        connect: async () => {
          const client = await pools.pricing.connect();
          return {
            release: client.release.bind(client),
            query: <Row>(sql: string, values?: readonly unknown[]) => {
              if (sql.includes("UPDATE pricing_repricing_dry_runs AS run SET consumed_at")) reachedConsumption();
              return client.query<Row>(sql, values);
            },
          };
        },
      };
      loser = services(store, observedPool).activateRepricingPolicy(activateInput(dryRunId), dryRunContext);
      void loser.then(
        () => {
          loserSettled = true;
        },
        () => {
          loserSettled = true;
        },
      );
      await atConsumption;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(loserSettled).toBe(false);
      release();
      expect(await winner).toMatchObject({ status: "active" });
      await expect(loser).rejects.toBeInstanceOf(DryRunRequiredError);
      expect(await createdEvents()).toHaveLength(1);
    } finally {
      release();
      await Promise.allSettled([winner, ...(loser ? [loser] : [])]);
    }
  });

  it("rolls back consumption and an appended event on transaction failure, then permits retry", async () => {
    const dryRunId = await completedRun();
    const store = createPostgresEventStore({ pool: pools.pricing });
    const failing: PostgresEventStore = {
      ...store,
      appendToStreamInTransaction: async (client, input) => {
        await store.appendToStreamInTransaction(client, input);
        throw new Error("synthetic failure after append before commit");
      },
    };
    await expect(services(failing).activateRepricingPolicy(activateInput(dryRunId), dryRunContext)).rejects.toThrow(
      "synthetic failure",
    );
    expect(await createdEvents()).toHaveLength(0);
    expect(
      (
        await pools.pricing.query<{ consumed_at: string | null }>(
          "SELECT consumed_at FROM pricing_repricing_dry_runs WHERE dry_run_id = $1",
          [dryRunId],
        )
      ).rows[0]?.consumed_at,
    ).toBeNull();
    expect(await services().activateRepricingPolicy(activateInput(dryRunId), dryRunContext)).toMatchObject({
      status: "active",
    });
    expect(await createdEvents()).toHaveLength(1);
  });
});
