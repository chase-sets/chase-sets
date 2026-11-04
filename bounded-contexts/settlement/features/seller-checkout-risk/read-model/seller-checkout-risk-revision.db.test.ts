import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as settlementModule } from "../../../index";
import {
  buildSettlementIdentityAccountRiskSourceProjectionHandlers,
  buildSettlementPaymentsAccountRiskSourceProjectionHandlers,
} from "../../wallets/integrations/account-risk-source/account-risk-source-projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;

function event(type: string, data: Record<string, unknown>): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${type.replace(/[^a-z0-9]+/gi, "_")}`,
    streamId: "identity.account-acc_revision",
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_revision" },
    timing: { occurredAt: "2026-11-04T00:00:00.000Z", recordedAt: "2026-11-04T00:00:00.000Z" },
  });
}

describeDb("seller checkout risk source revision persistence", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "seller_checkout_risk_revision");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function revision(accountId: string) {
    const result = await pool.query<{ revision: string }>(
      "SELECT revision::text FROM settlement_account_risk_sources WHERE account_id = $1",
      [accountId],
    );
    return result.rows[0]?.revision ?? null;
  }

  it("publishes revision one on fresh boot and preserves zero bootstrap parity", async () => {
    const handlers = buildSettlementIdentityAccountRiskSourceProjectionHandlers(pool);
    await handlers["identity.account.created"]!(event("identity.account.created", { accountId: "acc_revision" }));
    await expect(revision("acc_revision")).resolves.toBe("1");

    await pool.query(
      `INSERT INTO settlement_account_risk_sources (account_id, updated_at)
       VALUES ('acc_bootstrap', '2026-11-04T00:00:00.000Z')`,
    );
    await expect(revision("acc_bootstrap")).resolves.toBe("0");
  });

  it("increments conflicting writes atomically and keeps replay monotonic on an UNLOGGED table", async () => {
    const handlers = buildSettlementPaymentsAccountRiskSourceProjectionHandlers(pool);
    const warning = (receivedAt: string) =>
      handlers["payments.payment-fraud-warning-received"]!(
        event("payments.payment-fraud-warning-received", { buyerAccountId: "acc_revision", receivedAt }),
      );

    await Promise.all([warning("2026-11-04T00:00:01.000Z"), warning("2026-11-04T00:00:02.000Z")]);
    await expect(revision("acc_revision")).resolves.toBe("2");

    await pool.query("ALTER TABLE settlement_account_risk_sources SET UNLOGGED");
    await warning("2026-11-04T00:00:03.000Z");
    await expect(revision("acc_revision")).resolves.toBe("3");
  });

  it("backfills an existing zero-revision row through the same atomic writer", async () => {
    await pool.query(
      `INSERT INTO settlement_account_risk_sources (account_id, updated_at)
       VALUES ('acc_revision', '2026-11-04T00:00:00.000Z')`,
    );
    const handlers = buildSettlementIdentityAccountRiskSourceProjectionHandlers(pool);
    await handlers["identity.account.created"]!(event("identity.account.created", { accountId: "acc_revision" }));
    await expect(revision("acc_revision")).resolves.toBe("1");
  });
});
