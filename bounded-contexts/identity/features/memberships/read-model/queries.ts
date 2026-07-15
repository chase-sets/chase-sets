import {
  buildPaginationClause,
  escapeLikePattern,
  executeListQuery,
  type ListParams,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";

export type MembershipRow = Readonly<{
  membership_id: string;
  user_id: string;
  user_display_name: string | null;
  user_primary_email: string | null;
  account_id: string;
  account_display_name: string | null;
  account_name: string | null;
  role_key: string;
  role_permissions: readonly string[];
  status: string;
  updated_at: string;
}>;

export async function listMemberships(db: PgQueryable, params: ListParams = {}) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.status) {
    conditions.push(`memberships.status = $${paramIndex}`);
    values.push(params.status);
    paramIndex += 1;
  }

  if (params.search) {
    conditions.push(`(
      memberships.membership_id ILIKE $${paramIndex} ESCAPE '\\'
      OR memberships.user_id ILIKE $${paramIndex} ESCAPE '\\'
      OR users.display_name ILIKE $${paramIndex} ESCAPE '\\'
      OR users.primary_email ILIKE $${paramIndex} ESCAPE '\\'
      OR memberships.account_id ILIKE $${paramIndex} ESCAPE '\\'
      OR accounts.display_name ILIKE $${paramIndex} ESCAPE '\\'
      OR accounts.name ILIKE $${paramIndex} ESCAPE '\\'
      OR memberships.role_key ILIKE $${paramIndex} ESCAPE '\\'
    )`);
    values.push(`%${escapeLikePattern(params.search)}%`);
    paramIndex += 1;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = `FROM identity_memberships AS memberships
     LEFT JOIN identity_users AS users ON users.user_id = memberships.user_id
     LEFT JOIN identity_accounts AS accounts ON accounts.account_id = memberships.account_id`;
  const pagination = buildPaginationClause(params, paramIndex);

  return executeListQuery<MembershipRow>(
    db,
    `SELECT COUNT(*) AS count ${from} ${where}`,
    `SELECT memberships.membership_id,
            memberships.user_id,
            users.display_name AS user_display_name,
            users.primary_email AS user_primary_email,
            memberships.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            memberships.role_key,
            memberships.role_permissions,
            memberships.status,
            memberships.updated_at
     ${from}
     ${where}
     ORDER BY memberships.updated_at DESC
     ${pagination.sql}`,
    values,
    [...values, ...pagination.values],
  );
}

export async function getMembership(db: PgQueryable, membershipId: string) {
  const result = await db.query<MembershipRow>(
    `SELECT memberships.membership_id,
            memberships.user_id,
            users.display_name AS user_display_name,
            users.primary_email AS user_primary_email,
            memberships.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            memberships.role_key,
            memberships.role_permissions,
            memberships.status,
            memberships.updated_at
     FROM identity_memberships AS memberships
     LEFT JOIN identity_users AS users ON users.user_id = memberships.user_id
     LEFT JOIN identity_accounts AS accounts ON accounts.account_id = memberships.account_id
     WHERE memberships.membership_id = $1`,
    [membershipId],
  );
  return result.rows[0] ?? null;
}

export async function listMembershipsForUser(db: PgQueryable, userId: string) {
  const result = await db.query<MembershipRow>(
    `SELECT memberships.membership_id,
            memberships.user_id,
            users.display_name AS user_display_name,
            users.primary_email AS user_primary_email,
            memberships.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            memberships.role_key,
            '[]'::jsonb AS role_permissions,
            memberships.status,
            memberships.updated_at
     FROM identity_user_memberships AS memberships
     LEFT JOIN identity_users AS users ON users.user_id = memberships.user_id
     LEFT JOIN identity_accounts AS accounts ON accounts.account_id = memberships.account_id
     WHERE memberships.user_id = $1
     ORDER BY memberships.updated_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function getActiveMembershipForUserAccount(db: PgQueryable, userId: string, accountId: string) {
  const result = await db.query<MembershipRow>(
    `SELECT memberships.membership_id,
            memberships.user_id,
            users.display_name AS user_display_name,
            users.primary_email AS user_primary_email,
            memberships.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            memberships.role_key,
            memberships.role_permissions,
            memberships.status,
            memberships.updated_at
     FROM identity_memberships AS memberships
     LEFT JOIN identity_users AS users ON users.user_id = memberships.user_id
     LEFT JOIN identity_accounts AS accounts ON accounts.account_id = memberships.account_id
     WHERE memberships.user_id = $1
       AND memberships.account_id = $2
       AND memberships.status = 'active'
     ORDER BY memberships.updated_at DESC
     LIMIT 1`,
    [userId, accountId],
  );
  return result.rows[0] ?? null;
}

export async function countActiveOwnersForAccount(db: PgQueryable, accountId: string) {
  const result = await db.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count
     FROM identity_memberships
     WHERE account_id = $1
       AND role_key = 'owner'
       AND status = 'active'`,
    [accountId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
