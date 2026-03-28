import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
} from "../read-model-support/list-query";

export type MembershipRow = Readonly<{
  membership_id: string;
  user_id: string;
  account_id: string;
  role_key: string;
  role_permissions: readonly string[];
  status: string;
  updated_at: string;
}>;

export async function listMemberships(
  db: PgQueryable,
  params: ListParams = {},
) {
  const query = buildFilteredQuery(
    "identity_memberships",
    params,
    ["membership_id", "user_id", "account_id", "role_key"],
    "updated_at DESC",
  );
  return executeListQuery<MembershipRow>(db, query.countSql, query.listSql, query.values);
}

export async function getMembership(db: PgQueryable, membershipId: string) {
  const result = await db.query<MembershipRow>(
    `SELECT * FROM identity_memberships WHERE membership_id = $1`,
    [membershipId],
  );
  return result.rows[0] ?? null;
}

export async function listMembershipsForUser(db: PgQueryable, userId: string) {
  const result = await db.query<MembershipRow>(
    `SELECT membership_id, user_id, account_id, role_key, '[]'::jsonb AS role_permissions, status, updated_at
     FROM identity_user_memberships
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function getActiveMembershipForUserAccount(
  db: PgQueryable,
  userId: string,
  accountId: string,
) {
  const result = await db.query<MembershipRow>(
    `SELECT * FROM identity_memberships
     WHERE user_id = $1
       AND account_id = $2
       AND status = 'active'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId, accountId],
  );
  return result.rows[0] ?? null;
}
