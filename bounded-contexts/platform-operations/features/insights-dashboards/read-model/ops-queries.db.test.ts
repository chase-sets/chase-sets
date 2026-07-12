import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as platformOperationsModule } from "../../../index";
import { listGmvReconciliationRuns, runGmvReconciliation } from "./ops-queries";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["platform-operations"] as const;

describeDb("platform-operations GMV reconciliation run SQL persistence boundary", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "platform_operations_gmv_reconciliation",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools["platform-operations"];
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(platformOperationsModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("records a run's computed drift and persists it durably", async () => {
    const run = await runGmvReconciliation(pool, {
      yearMonth: "2026-07",
      tapeGmvAmount: "1000.00",
      ledgerSaleAmount: "950.00",
      now: "2026-08-01T00:05:00.000Z",
    });

    expect(run.status).toBe("ok");
    expect(run.deltaAmount).toBe("50.00");

    const runs = await listGmvReconciliationRuns(pool);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      yearMonth: "2026-07",
      tapeGmvAmount: "1000.00",
      ledgerSaleAmount: "950.00",
      status: "ok",
    });
  });

  it("records a drift-alarm run and lists most-recent-first", async () => {
    await runGmvReconciliation(pool, {
      yearMonth: "2026-06",
      tapeGmvAmount: "500.00",
      ledgerSaleAmount: "500.00",
      now: "2026-07-01T00:00:00.000Z",
    });
    await runGmvReconciliation(pool, {
      yearMonth: "2026-07",
      tapeGmvAmount: "1000.00",
      ledgerSaleAmount: "100.00",
      now: "2026-08-01T00:00:00.000Z",
    });

    const runs = await listGmvReconciliationRuns(pool);
    expect(runs).toHaveLength(2);
    expect(runs[0].yearMonth).toBe("2026-07");
    expect(runs[0].status).toBe("drift-alarm");
    expect(runs[1].yearMonth).toBe("2026-06");
    expect(runs[1].status).toBe("ok");
  });

  it("honors the limit parameter", async () => {
    for (let month = 1; month <= 3; month += 1) {
      await runGmvReconciliation(pool, {
        yearMonth: `2026-0${month}`,
        tapeGmvAmount: "100.00",
        ledgerSaleAmount: "90.00",
        now: `2026-0${month}-15T00:00:00.000Z`,
      });
    }

    const runs = await listGmvReconciliationRuns(pool, { limit: 2 });
    expect(runs).toHaveLength(2);
  });
});
