import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { normalizeEmail, normalizePhoneNumber } from "../../../support/runtime-support/common";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
} from "../../../support/read-model-support/list-query";

export type UserRow = Readonly<{
  user_id: string;
  display_name: string;
  given_name: string;
  family_name: string;
  primary_email: string | null;
  status: string;
  contact_methods: readonly unknown[];
  auth_methods: readonly string[];
  password_credential_id: string | null;
  passkey_credential_ids: readonly string[];
  social_login_links: readonly unknown[];
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

export async function getUserByPhone(db: PgQueryable, phone: string) {
  const result = await db.query<UserRow>(
    `SELECT users.*
     FROM identity_user_phones AS phones
     INNER JOIN identity_users AS users ON users.user_id = phones.user_id
     WHERE phones.phone = $1`,
    [normalizePhoneNumber(phone)],
  );
  return result.rows[0] ?? null;
}

export async function getUserBySocialLogin(
  db: PgQueryable,
  params: Readonly<{ providerName: string; providerSubject: string }>,
) {
  const result = await db.query<UserRow>(
    `SELECT users.*
     FROM identity_user_social_login_links AS links
     INNER JOIN identity_users AS users ON users.user_id = links.user_id
     WHERE links.provider_name = $1
       AND links.provider_subject = $2`,
    [params.providerName, params.providerSubject],
  );
  return result.rows[0] ?? null;
}
