import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";

export type ConsentRow = Readonly<{
  consent_id: string;
  subject_type: string;
  user_id: string | null;
  account_id: string | null;
  policy_key: string;
  policy_version: string;
  recorded_at: string;
  updated_at: string;
}>;

export type ConsentListParams = ListParams &
  Readonly<{
    userId?: string;
    accountId?: string;
  }>;

/**
 * Returns the most recently recorded consent fact for `policyKey` and the
 * given subject (user and/or account), or null if none exists. Used by the
 * Terms of Service acceptance gate to compare against the active required
 * version -- see `terms-acceptance.ts`.
 */
export async function findLatestConsent(
  db: PgQueryable,
  params: Readonly<{ userId?: string | null; accountId?: string | null; policyKey: string }>,
): Promise<ConsentRow | null> {
  if (!params.userId && !params.accountId) {
    return null;
  }

  const conditions = ["policy_key = $1"];
  const values: unknown[] = [params.policyKey];
  const subjectConditions: string[] = [];
  if (params.userId) {
    values.push(params.userId);
    subjectConditions.push(`user_id = $${values.length}`);
  }
  if (params.accountId) {
    values.push(params.accountId);
    subjectConditions.push(`account_id = $${values.length}`);
  }
  conditions.push(`(${subjectConditions.join(" OR ")})`);

  const result = await db.query<ConsentRow>(
    `SELECT consent_id, subject_type, user_id, account_id, policy_key, policy_version, recorded_at, updated_at
     FROM identity_consents
     WHERE ${conditions.join(" AND ")}
     ORDER BY recorded_at DESC, consent_id DESC
     LIMIT 1`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function listConsents(db: PgQueryable, params: ConsentListParams = {}) {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];

  if (params.userId) {
    extraConditions.push(`user_id = $${extraValues.length + 1}`);
    extraValues.push(params.userId);
  }

  if (params.accountId) {
    extraConditions.push(`account_id = $${extraValues.length + 1}`);
    extraValues.push(params.accountId);
  }

  const query = buildFilteredQuery(
    "identity_consents",
    params,
    ["policy_key", "policy_version", "subject_type"],
    "recorded_at DESC",
    extraConditions,
    extraValues,
  );
  return executeListQuery<ConsentRow>(db, query.countSql, query.listSql, query.countValues, query.listValues);
}
