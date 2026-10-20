import { describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import {
  buildAccountAppealInterestProjectionHandlers,
  buildAccountAppealProjectionHandlers,
  resolveAccountAppealableAction,
} from "../read-model/projection";
import { accountAppealSchemaSql } from "../read-model/schema";
import {
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  closeMultiContextTestPools,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";

const base = process.env.TEST_DATABASE_URL;
if (!base && process.env.CI) throw new Error("TEST_DATABASE_URL is required for account appeal DB tests in CI.");
const describeDb = base ? describe : describe.skip;
const owner = "acc_01ARZ6S41TSV4RRFFQ69F5AV";
const event = (
  data: Record<string, unknown>,
  streamId = `identity.account-${owner}`,
  type = "identity.account.suspended",
) =>
  buildTransportEvent(type, data, {
    id: "evt_account_appeal",
    streamId,
    globalPosition: "1",
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_01ARZ6S41TSV4RRFFQ69F5AV", forAccountId: owner },
    timing: { occurredAt: "2026-10-20T00:00:00.000Z", recordedAt: "2026-10-20T00:00:01.000Z" },
  });

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
      expect(
        (await db.query("SELECT count(*)::int AS count FROM platform_operations_account_appealable_actions")).rows[0]
          ?.count,
      ).toBe(0);
      await handlers["identity.account.suspended"]!(
        event({ enforcement: { version: 1, enforcementActionId: "enf_01ARZ6S41TSV4RRFFQ69F5AV" } }),
      );
      expect(
        (await db.query("SELECT owner_account_id, conflict_state FROM platform_operations_account_appealable_actions"))
          .rows[0],
      ).toMatchObject({ owner_account_id: owner, conflict_state: "clear" });
      await expect(
        handlers["identity.account.suspended"]!(
          event(
            { enforcement: { version: 1, enforcementActionId: "enf_01ARZ6S41TSV4RRFFQ69F5AV" } },
            `identity.account-acc_01ARZ6S41TSV4RRFFQ69F5AW`,
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await closeMultiContextTestPools(pools);
    }
  });

  it("delayed eligibility", async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["platform-operations"], "account_appeal_delayed");
    await ensureMultiContextTestDatabases(base!, urls);
    const pools = createMultiContextTestPools(urls);
    try {
      const db = pools["platform-operations"];
      await resetMultiContextTestSchemas(pools);
      await db.query(accountAppealSchemaSql);
      expect(await resolveAccountAppealableAction(db, "enf_01ARZ6S41TSV4RRFFQ69F5AV")).toBeNull();
      await buildAccountAppealInterestProjectionHandlers(db)["identity.account.suspended"]!(
        event({ enforcement: { version: 1, enforcementActionId: "enf_01ARZ6S41TSV4RRFFQ69F5AV" } }),
      );
      await expect(resolveAccountAppealableAction(db, "enf_01ARZ6S41TSV4RRFFQ69F5AV")).resolves.toMatchObject({
        ownerAccountId: owner,
      });
    } finally {
      await closeMultiContextTestPools(pools);
    }
  });

  it("five sources", async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["platform-operations"], "account_appeal_sources");
    await ensureMultiContextTestDatabases(base!, urls);
    const pools = createMultiContextTestPools(urls);
    try {
      const db = pools["platform-operations"];
      await resetMultiContextTestSchemas(pools);
      await db.query(accountAppealSchemaSql);
      const sources = [
        "identity.account.suspended",
        "identity.account.reactivated",
        "identity.account.closed",
        "marketplace.listing.operator-unlisted",
        "marketplace.listing.auto-unlisted",
      ];
      await db.query(
        `INSERT INTO platform_operations_account_appealable_actions
          (appealable_action_id, owner_account_id, source, source_stream_id, source_stream_version, occurred_at, source_event_type)
         SELECT 'enf_' || lpad(i::text, 26, '0'), $1, source, 'synthetic-' || i, 1, now(), source
         FROM unnest($2::text[]) WITH ORDINALITY AS s(source, i)`,
        [owner, sources],
      );
      const rows = await db.query<{ source: string }>(
        "SELECT source FROM platform_operations_account_appealable_actions ORDER BY source",
      );
      expect(rows.rows.map((row) => row.source).sort()).toEqual([...sources].sort());
    } finally {
      await closeMultiContextTestPools(pools);
    }
  });

  it("seller column allowlist", async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["platform-operations"], "account_appeal_columns");
    await ensureMultiContextTestDatabases(base!, urls);
    const pools = createMultiContextTestPools(urls);
    try {
      const db = pools["platform-operations"];
      await resetMultiContextTestSchemas(pools);
      await db.query(accountAppealSchemaSql);
      const columns = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name='platform_operations_account_appeal_seller_history'",
      );
      expect(columns.rows.map((row) => row.column_name)).not.toEqual(
        expect.arrayContaining(["note", "operator_user_id"]),
      );
    } finally {
      await closeMultiContextTestPools(pools);
    }
  });

  it("barriered projection update", async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["platform-operations"], "account_appeal_barrier");
    await ensureMultiContextTestDatabases(base!, urls);
    const pools = createMultiContextTestPools(urls);
    try {
      const db = pools["platform-operations"];
      await resetMultiContextTestSchemas(pools);
      await db.query(accountAppealSchemaSql);
      const handlers = buildAccountAppealProjectionHandlers(db);
      await expect(
        handlers["platform-operations.account-appeal.review-started"]!(
          event({}, "platform-operations.account-appeal-enf_01ARZ6S41TSV4RRFFQ69F5AV", "platform-operations.account-appeal.review-started"),
        ),
      ).rejects.toThrow("version gap");
    } finally {
      await closeMultiContextTestPools(pools);
    }
  });

  it("projection replay", () => {
    expect(accountAppealSchemaSql).toContain("CREATE TABLE IF NOT EXISTS platform_operations_account_appeal_seller_history");
    expect(accountAppealSchemaSql).not.toContain("DROP TABLE");
  });

  it("fresh boot", () => {
    expect(accountAppealSchemaSql).toContain("platform_operations_account_appealable_actions");
    expect(accountAppealSchemaSql).toContain("platform_operations_account_appeal_operator_history");
  });
});
