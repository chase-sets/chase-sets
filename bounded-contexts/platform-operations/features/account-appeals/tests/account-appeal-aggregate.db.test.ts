import { describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildAccountAppealInterestProjectionHandlers } from "../read-model/projection";
import { accountAppealSchemaSql } from "../read-model/schema";
import { createMultiContextTestDatabaseUrls, createMultiContextTestPools, ensureMultiContextTestDatabases, closeMultiContextTestPools, resetMultiContextTestSchemas } from "@chase-sets/bounded-context-runtime/test-support";

const base = process.env.TEST_DATABASE_URL;
if (!base && process.env.CI) throw new Error("TEST_DATABASE_URL is required for account appeal DB tests in CI.");
const describeDb = base ? describe : describe.skip;
const owner = "acc_01ARZ6S41TSV4RRFFQ69F5AV";
const event = (data: Record<string, unknown>, streamId = `identity.account-${owner}`) => buildTransportEvent("identity.account.suspended", data, { id: "evt_account_appeal", streamId, globalPosition: "1", tenantId: "tnt_test", audit: { performedByUserId: "usr_01ARZ6S41TSV4RRFFQ69F5AV", forAccountId: owner }, timing: { occurredAt: "2026-10-20T00:00:00.000Z", recordedAt: "2026-10-20T00:00:01.000Z" } });

describeDb("account appeal aggregate DB proof", () => {
  it("legacy versus modern and immutable attribution", async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["platform-operations"], "account_appeal_aggregate");
    await ensureMultiContextTestDatabases(base!, urls);
    const pools = createMultiContextTestPools(urls);
    try {
      const db = pools["platform-operations"];
      await resetMultiContextTestSchemas(pools);
      await db.query(accountAppealSchemaSql);
      const handlers = buildAccountAppealInterestProjectionHandlers(db);
      await handlers["identity.account.suspended"]!(event({}));
      expect((await db.query("SELECT count(*)::int AS count FROM platform_operations_account_appealable_actions")).rows[0]?.count).toBe(0);
      await handlers["identity.account.suspended"]!(event({ enforcement: { version: 1, enforcementActionId: "enf_01ARZ6S41TSV4RRFFQ69F5AV" } }));
      expect((await db.query("SELECT owner_account_id, conflict_state FROM platform_operations_account_appealable_actions")).rows[0]).toMatchObject({ owner_account_id: owner, conflict_state: "clear" });
      await expect(handlers["identity.account.suspended"]!(event({ enforcement: { version: 1, enforcementActionId: "enf_01ARZ6S41TSV4RRFFQ69F5AV" } }, `identity.account-acc_01ARZ6S41TSV4RRFFQ69F5AW`))).rejects.toThrow();
    } finally { await closeMultiContextTestPools(pools); }
  });
});
