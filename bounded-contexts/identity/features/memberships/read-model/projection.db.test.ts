import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "@chase-sets/auth-context";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { ROLE_KEYS } from "../../../support/runtime-support/common";
import { buildMembershipProjectionHandlers } from "./projection";
import { identityMembershipSchemaSql } from "./schema";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for the membership projection database proof in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["identity"] as const;

// Every role is granted once, then each membership moves to the next role, so
// both projection writes of role_permissions run for every role.
const history = ROLE_KEYS.flatMap((roleKey, index) => {
  const membershipId = `mbr_synthetic_rebuild_${index}`;
  const streamId = `identity.membership-${membershipId}`;
  const nextRoleKey = ROLE_KEYS[(index + 1) % ROLE_KEYS.length]!;
  const granted: string = "identity.membership.granted";
  const roleChanged: string = "identity.membership.role-changed";
  return [
    buildTransportEvent(
      granted,
      { membershipId, userId: `usr_synthetic_rebuild_${index}`, accountId: "acc_synthetic_rebuild", roleKey },
      { streamId, streamVersion: 1, globalPosition: String(index * 2 + 1) },
    ),
    buildTransportEvent(
      roleChanged,
      { roleKey: nextRoleKey },
      { streamId, streamVersion: 2, globalPosition: String(index * 2 + 2) },
    ),
  ];
});

describeDb("membership projection rebuild", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "identity_membership_projection",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.identity;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ identity: pool });
    await pool.query(identityMembershipSchemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function replay(events: readonly (typeof history)[number][]) {
    const handlers = buildMembershipProjectionHandlers(pool);
    for (const event of events) {
      await handlers[event.type]!(event);
    }
  }

  async function membershipRows() {
    const result = await pool.query<{ membership_id: string; role_key: string; role_permissions: string[] }>(
      `SELECT membership_id, role_key, role_permissions
       FROM identity_memberships
       ORDER BY membership_id`,
    );
    return result.rows;
  }

  function expectCanonical(rows: Awaited<ReturnType<typeof membershipRows>>) {
    expect(rows.map((row) => row.role_key).sort()).toEqual([...ROLE_KEYS].sort());
    for (const row of rows) {
      expect(row.role_permissions, row.role_key).toEqual(
        ROLE_PERMISSIONS[row.role_key as keyof typeof ROLE_PERMISSIONS],
      );
    }
  }

  it("writes role_permissions equal to the canonical table for every role on grant", async () => {
    await replay(history.filter((event) => event.type === "identity.membership.granted"));
    expectCanonical(await membershipRows());
  });

  it("rebuilds role_permissions equal to the canonical table after role changes, over stale snapshots", async () => {
    await replay(history);
    const projected = await membershipRows();
    expectCanonical(projected);

    // A stale snapshot, such as a row written from Identity's pre-move table
    // without projection-operations.*, is overwritten by the replay.
    await pool.query(`UPDATE identity_memberships SET role_permissions = '["accounts.view"]'::jsonb`);
    await replay(history);
    expect(await membershipRows()).toEqual(projected);

    await pool.query("TRUNCATE identity_memberships, identity_user_memberships");
    await replay(history);
    expect(await membershipRows()).toEqual(projected);
  });
});
