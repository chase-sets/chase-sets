import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { getAccessHome } from "../features/access-hub/read-model/queries";
import { buildAccountProjectionHandlers } from "../features/accounts/read-model/projection";
import { identityAccountSchemaMigrations, identityAccountSchemaSql } from "../features/accounts/read-model/schema";
import { getAccount, listAccounts } from "../features/accounts/read-model/queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Account Enforcement Action database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["identity"] as const;

const ACCOUNT_ID = "acc_01ARYZ6S41TSV4RRFFQ69G5FAV";
const ACTION_A = "enf_01ARYZ6S41TSV4RRFFQ69G5FAV";
const ACTION_B = "enf_01ARYZ6S41TSV4RRFFQ69G5FAW";
const ACTION_C = "enf_01ARYZ6S41TSV4RRFFQ69G5FAX";
const SUPPORT_REQUEST = "sup_01ARYZ6S41TSV4RRFFQ69G5FAV";

describeDb("Account Enforcement Action projection", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "identity_account_enforcement",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.identity;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ identity: pool });
    await pool.query(identityAccountSchemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  function event(
    type: string,
    data: Record<string, unknown>,
    globalPosition: string,
    recordedAt = `2026-08-19T00:00:${globalPosition.padStart(2, "0")}.000Z`,
    accountId = ACCOUNT_ID,
  ) {
    return buildTransportEvent(type, data, {
      streamId: `identity.account-${accountId}`,
      globalPosition,
      timing: { occurredAt: recordedAt, recordedAt },
    });
  }

  async function project(type: string, data: Record<string, unknown>, position: string, recordedAt?: string) {
    const handler = buildAccountProjectionHandlers(pool)[type];
    if (!handler) {
      throw new Error(`Missing account projection handler for ${type}.`);
    }
    await handler(event(type, data, position, recordedAt));
  }

  async function projectCreated(position = "1") {
    await project(
      "identity.account.created",
      {
        accountId: ACCOUNT_ID,
        name: "Card Vault LLC",
        displayName: "Card Vault",
        accountType: "business",
      },
      position,
    );
  }

  async function rawRow() {
    const result = await pool.query<{
      status: string;
      last_enforcement_action_id: string | null;
      last_enforcement_reason: string | null;
      last_enforcement_reference: unknown | null;
      last_enforcement_at: Date | null;
      last_global_position: string | null;
    }>(
      `SELECT status,
              last_enforcement_action_id,
              last_enforcement_reason,
              last_enforcement_reference,
              last_enforcement_at,
              last_global_position::text
       FROM identity_accounts
       WHERE account_id = $1`,
      [ACCOUNT_ID],
    );
    return result.rows[0]!;
  }

  it("adds all five nullable columns on fresh boot and through the ledgered migration", async () => {
    const columns = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'identity_accounts'
         AND column_name = ANY($1::text[])
       ORDER BY column_name`,
      [
        [
          "last_enforcement_action_id",
          "last_enforcement_reason",
          "last_enforcement_reference",
          "last_enforcement_at",
          "last_global_position",
        ],
      ],
    );
    expect(columns.rows).toEqual([
      { column_name: "last_enforcement_action_id", is_nullable: "YES" },
      { column_name: "last_enforcement_at", is_nullable: "YES" },
      { column_name: "last_enforcement_reason", is_nullable: "YES" },
      { column_name: "last_enforcement_reference", is_nullable: "YES" },
      { column_name: "last_global_position", is_nullable: "YES" },
    ]);

    const migration = identityAccountSchemaMigrations.find(
      ({ migrationId }) => migrationId === "20260819_identity_account_enforcement_fact",
    );
    expect(migration).toBeDefined();
    await projectCreated();
    for (const statement of migration!.statements) {
      await pool.query(statement);
      await pool.query(statement);
    }
    expect((await rawRow()).last_enforcement_action_id).toBeNull();
  });

  it("replays legacy-only history with null facts and a precise global position", async () => {
    await projectCreated();
    await project("identity.account.suspended", {}, "2");
    await project("identity.account.reactivated", {}, "3");
    await project("identity.account.closed", {}, "4");

    expect(await rawRow()).toMatchObject({
      status: "closed",
      last_enforcement_action_id: null,
      last_enforcement_reason: null,
      last_enforcement_reference: null,
      last_enforcement_at: null,
      last_global_position: "4",
    });
  });

  it("retains a modern suffix after a legacy restriction", async () => {
    await projectCreated();
    await project("identity.account.suspended", {}, "2");
    await project(
      "identity.account.reactivated",
      {
        enforcement: {
          version: 1,
          enforcementActionId: ACTION_B,
          reason: "issue-resolved",
          reference: null,
        },
      },
      "3",
    );

    expect(await rawRow()).toMatchObject({
      status: "active",
      last_enforcement_action_id: ACTION_B,
      last_enforcement_reason: "issue-resolved",
      last_enforcement_reference: null,
      last_global_position: "3",
    });
  });

  it("round-trips Suspend to Reactivate to Suspend while public queries omit internal facts", async () => {
    await projectCreated();
    await project(
      "identity.account.suspended",
      {
        enforcement: {
          version: 1,
          enforcementActionId: ACTION_A,
          reason: "policy-violation",
          reference: { kind: "support-request", supportRequestId: SUPPORT_REQUEST },
        },
      },
      "2",
    );
    await project(
      "identity.account.reactivated",
      { enforcement: { version: 1, enforcementActionId: ACTION_B, reason: "appeal-upheld", reference: null } },
      "3",
    );
    await project(
      "identity.account.suspended",
      { enforcement: { version: 1, enforcementActionId: ACTION_C, reason: "payment-risk", reference: null } },
      "4",
      "2026-08-19T12:34:56.000Z",
    );

    expect(await rawRow()).toMatchObject({
      status: "suspended",
      last_enforcement_action_id: ACTION_C,
      last_enforcement_reason: "payment-risk",
      last_enforcement_reference: null,
      last_global_position: "4",
    });
    expect((await rawRow()).last_enforcement_at?.toISOString()).toBe("2026-08-19T12:34:56.000Z");
    const publicAccounts = [(await listAccounts(pool)).items[0], await getAccount(pool, ACCOUNT_ID)];
    for (const publicAccount of publicAccounts) {
      for (const internalKey of [
        "last_enforcement_action_id",
        "last_enforcement_reason",
        "last_enforcement_reference",
        "last_enforcement_at",
        "last_global_position",
      ]) {
        expect(publicAccount).not.toHaveProperty(internalKey);
      }
    }
  });

  it("exposes getAccessHome suspended-account rows as exactly the public account column set", async () => {
    await projectCreated();
    await project(
      "identity.account.suspended",
      {
        enforcement: {
          version: 1,
          enforcementActionId: ACTION_A,
          reason: "policy-violation",
          reference: { kind: "support-request", supportRequestId: SUPPORT_REQUEST },
        },
      },
      "2",
    );

    const home = await getAccessHome(pool, {
      scopeAccountId: ACCOUNT_ID,
      includeMemberships: false,
      includeApiKeys: false,
    });

    expect(home.attention.suspended_accounts).toHaveLength(1);
    const [suspendedAccount] = home.attention.suspended_accounts;
    expect(suspendedAccount.status).toBe("suspended");
    expect(Object.keys(suspendedAccount).sort()).toEqual(
      [
        "account_id",
        "name",
        "display_name",
        "account_type",
        "status",
        "badges",
        "founder_number",
        "founders_window_started_at",
        "founders_window_ends_at",
        "updated_at",
      ].sort(),
    );
    for (const internalKey of [
      "last_enforcement_action_id",
      "last_enforcement_reason",
      "last_enforcement_reference",
      "last_enforcement_at",
      "last_global_position",
    ]) {
      expect(suspendedAccount).not.toHaveProperty(internalKey);
    }
  });

  it("uses last_global_position across a real profile-write interleaving and reverse delivery", async () => {
    await projectCreated();
    const profileWriter = await pool.connect();
    const lifecycleWriter = await pool.connect();
    let profileCommitted = false;
    try {
      await profileWriter.query("BEGIN");
      await profileWriter.query(
        `UPDATE identity_accounts
         SET name = 'New Name',
             display_name = 'New Display',
             updated_at = '2026-08-19T23:59:59.000Z'
         WHERE account_id = $1`,
        [ACCOUNT_ID],
      );

      let markLifecycleQueryStarted!: () => void;
      const lifecycleQueryStarted = new Promise<void>((resolve) => {
        markLifecycleQueryStarted = resolve;
      });
      const interleavedQuery = async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        const result = lifecycleWriter.query<Row>(sql, values);
        markLifecycleQueryStarted();
        return result;
      };
      const interleavedDb: PgQueryable = {
        query: interleavedQuery,
      };
      const suspended = buildAccountProjectionHandlers(interleavedDb)["identity.account.suspended"]!;
      const lifecycleWrite = suspended(
        event(
          "identity.account.suspended",
          { enforcement: { version: 1, enforcementActionId: ACTION_A, reason: "operator-other", reference: null } },
          "20",
        ),
      );
      await lifecycleQueryStarted;
      await profileWriter.query("COMMIT");
      profileCommitted = true;
      await lifecycleWrite;
    } finally {
      if (!profileCommitted) {
        await profileWriter.query("ROLLBACK");
      }
      profileWriter.release();
      lifecycleWriter.release();
    }

    await project(
      "identity.account.reactivated",
      { enforcement: { version: 1, enforcementActionId: ACTION_B, reason: "operator-error", reference: null } },
      "22",
      "2026-08-19T00:00:22.000Z",
    );
    await project(
      "identity.account.suspended",
      { enforcement: { version: 1, enforcementActionId: ACTION_A, reason: "operator-other", reference: null } },
      "20",
    );

    expect(await rawRow()).toMatchObject({
      status: "active",
      last_enforcement_action_id: ACTION_B,
      last_enforcement_reason: "operator-error",
      last_global_position: "22",
    });
  });

  it("keeps the pre-slice status reader compatible with additive columns and modern payloads", async () => {
    await projectCreated();
    await project(
      "identity.account.closed",
      { enforcement: { version: 1, enforcementActionId: ACTION_C, reason: "seller-requested", reference: null } },
      "8",
    );

    const modernReactivation = event(
      "identity.account.reactivated",
      { enforcement: { version: 1, enforcementActionId: ACTION_B, reason: "issue-resolved", reference: null } },
      "9",
    );
    const preSliceProjectionShape = async (lifecycleEvent: typeof modernReactivation) => {
      await pool.query(
        `UPDATE identity_accounts
         SET status = 'active',
             updated_at = $2
         WHERE account_id = $1`,
        [ACCOUNT_ID, lifecycleEvent.timing.recordedAt],
      );
    };
    await preSliceProjectionShape(modernReactivation);

    const preSliceReader = await pool.query<{ account_id: string; status: string }>(
      "SELECT account_id, status FROM identity_accounts WHERE account_id = $1",
      [ACCOUNT_ID],
    );
    expect(preSliceReader.rows).toEqual([{ account_id: ACCOUNT_ID, status: "active" }]);
    expect((await rawRow()).last_enforcement_action_id).toBe(ACTION_C);
  });
});
