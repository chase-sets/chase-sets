import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { normalizeEmail } from "../common";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
} from "../read-model-support/list-query";

export type UserRow = Readonly<{
  user_id: string;
  display_name: string;
  given_name: string;
  family_name: string;
  primary_email: string;
  status: string;
  contact_methods: readonly unknown[];
  auth_methods: readonly string[];
  password_credential_id: string | null;
  passkey_credential_ids: readonly string[];
  updated_at: string;
}>;

export async function listUsers(
  db: PgQueryable,
  params: ListParams = {},
) {
  const query = buildFilteredQuery(
    "identity_users",
    params,
    ["display_name", "primary_email", "given_name", "family_name"],
    "display_name ASC",
  );
  return executeListQuery<UserRow>(db, query.countSql, query.listSql, query.values);
}

export async function getUser(db: PgQueryable, userId: string) {
  const result = await db.query<UserRow>(
    `SELECT * FROM identity_users WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function getUserByEmail(db: PgQueryable, email: string) {
  const result = await db.query<UserRow>(
    `SELECT users.*
     FROM identity_user_emails AS emails
     INNER JOIN identity_users AS users ON users.user_id = emails.user_id
     WHERE emails.email = $1`,
    [normalizeEmail(email)],
  );
  return result.rows[0] ?? null;
}
