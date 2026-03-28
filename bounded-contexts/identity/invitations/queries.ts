import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { normalizeEmail } from "../common";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
} from "../read-model-support/list-query";

export type InvitationRow = Readonly<{
  invitation_id: string;
  account_id: string;
  email: string;
  role_key: string;
  status: string;
  expires_at: string;
  accepted_by_user_id: string | null;
  updated_at: string;
}>;

export async function listInvitations(
  db: PgQueryable,
  params: ListParams = {},
) {
  const query = buildFilteredQuery(
    "identity_invitations",
    params,
    ["email", "role_key", "account_id"],
    "updated_at DESC",
  );
  return executeListQuery<InvitationRow>(db, query.countSql, query.listSql, query.values);
}

export async function getInvitation(db: PgQueryable, invitationId: string) {
  const result = await db.query<InvitationRow>(
    `SELECT * FROM identity_invitations WHERE invitation_id = $1`,
    [invitationId],
  );
  return result.rows[0] ?? null;
}

export async function getPendingInvitationByEmail(db: PgQueryable, email: string) {
  const result = await db.query<InvitationRow>(
    `SELECT *
     FROM identity_invitations
     WHERE email = $1
       AND status = 'pending'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [normalizeEmail(email)],
  );
  return result.rows[0] ?? null;
}
