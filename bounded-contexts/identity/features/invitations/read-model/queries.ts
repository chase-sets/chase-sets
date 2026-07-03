import {
  buildPaginationClause,
  escapeLikePattern,
  executeListQuery,
  type ListParams,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { normalizeEmail } from "../../../support/runtime-support/common";

export type InvitationRow = Readonly<{
  invitation_id: string;
  account_id: string;
  account_display_name: string | null;
  account_name: string | null;
  email: string;
  role_key: string;
  status: string;
  expires_at: string;
  accepted_by_user_id: string | null;
  accepted_by_user_display_name: string | null;
  accepted_by_user_primary_email: string | null;
  updated_at: string;
}>;

export async function listInvitations(db: PgQueryable, params: ListParams = {}) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.status) {
    conditions.push(`invitations.status = $${paramIndex}`);
    values.push(params.status);
    paramIndex += 1;
  }

  if (params.search) {
    conditions.push(`(
      invitations.email ILIKE $${paramIndex} ESCAPE '\\'
      OR invitations.role_key ILIKE $${paramIndex} ESCAPE '\\'
      OR invitations.account_id ILIKE $${paramIndex} ESCAPE '\\'
      OR accounts.display_name ILIKE $${paramIndex} ESCAPE '\\'
      OR accounts.name ILIKE $${paramIndex} ESCAPE '\\'
      OR accepted_users.display_name ILIKE $${paramIndex} ESCAPE '\\'
      OR accepted_users.primary_email ILIKE $${paramIndex} ESCAPE '\\'
    )`);
    values.push(`%${escapeLikePattern(params.search)}%`);
    paramIndex += 1;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = `FROM identity_invitations AS invitations
     LEFT JOIN identity_accounts AS accounts ON accounts.account_id = invitations.account_id
     LEFT JOIN identity_users AS accepted_users ON accepted_users.user_id = invitations.accepted_by_user_id`;
  const pagination = buildPaginationClause(params, paramIndex);

  return executeListQuery<InvitationRow>(
    db,
    `SELECT COUNT(*) AS count ${from} ${where}`,
    `SELECT invitations.invitation_id,
            invitations.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            invitations.email,
            invitations.role_key,
            invitations.status,
            invitations.expires_at,
            invitations.accepted_by_user_id,
            accepted_users.display_name AS accepted_by_user_display_name,
            accepted_users.primary_email AS accepted_by_user_primary_email,
            invitations.updated_at
     ${from}
     ${where}
     ORDER BY invitations.updated_at DESC
     ${pagination.sql}`,
    values,
    [...values, ...pagination.values],
  );
}

export async function getInvitation(db: PgQueryable, invitationId: string) {
  const result = await db.query<InvitationRow>(
    `SELECT invitations.invitation_id,
            invitations.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            invitations.email,
            invitations.role_key,
            invitations.status,
            invitations.expires_at,
            invitations.accepted_by_user_id,
            accepted_users.display_name AS accepted_by_user_display_name,
            accepted_users.primary_email AS accepted_by_user_primary_email,
            invitations.updated_at
     FROM identity_invitations AS invitations
     LEFT JOIN identity_accounts AS accounts ON accounts.account_id = invitations.account_id
     LEFT JOIN identity_users AS accepted_users ON accepted_users.user_id = invitations.accepted_by_user_id
     WHERE invitations.invitation_id = $1`,
    [invitationId],
  );
  return result.rows[0] ?? null;
}

export async function getPendingInvitationByEmail(db: PgQueryable, email: string) {
  const result = await db.query<InvitationRow>(
    `SELECT invitations.invitation_id,
            invitations.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            invitations.email,
            invitations.role_key,
            invitations.status,
            invitations.expires_at,
            invitations.accepted_by_user_id,
            accepted_users.display_name AS accepted_by_user_display_name,
            accepted_users.primary_email AS accepted_by_user_primary_email,
            invitations.updated_at
     FROM identity_invitations AS invitations
     LEFT JOIN identity_accounts AS accounts ON accounts.account_id = invitations.account_id
     LEFT JOIN identity_users AS accepted_users ON accepted_users.user_id = invitations.accepted_by_user_id
     WHERE invitations.email = $1
       AND invitations.status = 'pending'
     ORDER BY invitations.updated_at DESC
     LIMIT 1`,
    [normalizeEmail(email)],
  );
  return result.rows[0] ?? null;
}
