import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as settlementModule } from "../../../../index";
import { createSettlementServices } from "../../../../support/runtime-support/services";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for DB-backed tests in CI.");
const describeDb = adminDatabaseUrl ? describe : describe.skip;
const operatorContext: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_operator" as never, forAccountId: "acc_operator" as never },
};

describeDb("settlement Account Linkage closer", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<"settlement", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["settlement"], "account_linkage_closer");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(settlementModule, pool);
    // Boot twice is the rolling-deploy guard: additive schema and the cursor
    // migration must both be idempotent on a disposable PostgreSQL 16 profile.
    await bootstrapContextDatabase(settlementModule, pool);
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  it("publishes from projected active membership, updates changed sets, clears, and re-raises", async () => {
    const rawClusterKey = "provider-payment-instrument-private-value";
    await pool.query(
      `INSERT INTO settlement_account_instrument_risk_sources
         (account_id, instrument_id, instrument_cluster_key, active, updated_at)
       VALUES
         ('acc_a', 'pi_a', $1, TRUE, now()),
         ('acc_b', 'pi_b', $1, TRUE, now()),
         ('acc_inactive', 'pi_inactive', $1, FALSE, now()),
         ('acc_singleton', 'pi_singleton', 'singleton-private', TRUE, now())`,
      [rawClusterKey],
    );
    const services = createSettlementServices(pool);

    await expect(services.accountLinkage.runAccountLinkageCloser()).resolves.toEqual({
      clustersConsidered: 1,
      flagsPublished: 1,
      unchanged: 0,
    });
    await services.accountLinkage.runAccountLinkageCloser();

    let events = await linkageEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "settlement.account-linkage.flagged",
      payload: { signalKind: "shared-instrument", accountIds: ["acc_a", "acc_b"] },
    });
    expect(Object.keys(events[0]!.payload).sort()).toEqual(["accountIds", "clusterHash", "signalKind"]);
    expect(JSON.stringify(events[0]!.payload)).not.toContain(rawClusterKey);
    expect(events[0]!.stream_id).not.toContain(rawClusterKey);

    await pool.query(
      `INSERT INTO settlement_account_instrument_risk_sources
         (account_id, instrument_id, instrument_cluster_key, active, updated_at)
       VALUES ('acc_c', 'pi_c', $1, TRUE, now())`,
      [rawClusterKey],
    );
    await services.accountLinkage.runAccountLinkageCloser();
    events = await linkageEvents();
    expect(events[1]).toMatchObject({
      event_type: "settlement.account-linkage.flagged",
      payload: { accountIds: ["acc_a", "acc_b", "acc_c"] },
    });

    const clusterHash = String(events[1]!.payload.clusterHash);
    await expect(services.accountLinkage.clearAccountLinkage(clusterHash, operatorContext)).resolves.toBe("cleared");
    await services.accountLinkage.runAccountLinkageCloser();
    events = await linkageEvents();
    expect(events.map((event) => event.event_type)).toEqual([
      "settlement.account-linkage.flagged",
      "settlement.account-linkage.flagged",
      "settlement.account-linkage.cleared",
      "settlement.account-linkage.flagged",
    ]);
  });

  it("clears a previously flagged cluster when membership shrinks 3 to 2 to 1", async () => {
    const rawClusterKey = "shrinking-private-instrument-cluster";
    await pool.query(
      `INSERT INTO settlement_account_instrument_risk_sources
         (account_id, instrument_id, instrument_cluster_key, active, updated_at)
       VALUES
         ('acc_a', 'pi_a', $1, TRUE, now()),
         ('acc_b', 'pi_b', $1, TRUE, now()),
         ('acc_c', 'pi_c', $1, TRUE, now())`,
      [rawClusterKey],
    );
    const services = createSettlementServices(pool);

    await services.accountLinkage.runAccountLinkageCloser();
    await pool.query(
      `UPDATE settlement_account_instrument_risk_sources
       SET active = FALSE, updated_at = now()
       WHERE account_id = 'acc_c' AND instrument_cluster_key = $1`,
      [rawClusterKey],
    );
    await services.accountLinkage.runAccountLinkageCloser();
    await pool.query(
      `UPDATE settlement_account_instrument_risk_sources
       SET active = FALSE, updated_at = now()
       WHERE account_id = 'acc_b' AND instrument_cluster_key = $1`,
      [rawClusterKey],
    );
    await services.accountLinkage.runAccountLinkageCloser();

    const events = await linkageEvents();
    expect(events.map((event) => ({ eventType: event.event_type, accountIds: event.payload.accountIds }))).toEqual([
      { eventType: "settlement.account-linkage.flagged", accountIds: ["acc_a", "acc_b", "acc_c"] },
      { eventType: "settlement.account-linkage.flagged", accountIds: ["acc_a", "acc_b"] },
      { eventType: "settlement.account-linkage.cleared", accountIds: ["acc_a", "acc_b"] },
    ]);
  });

  async function linkageEvents() {
    const result = await pool.query<{ event_type: string; stream_id: string; payload: Record<string, unknown> }>(
      `SELECT event_type, stream_id, payload
       FROM event_store_events
       WHERE event_type IN ('settlement.account-linkage.flagged', 'settlement.account-linkage.cleared')
       ORDER BY global_position`,
    );
    return result.rows;
  }
});
