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
  status: "recorded" | "withdrawn";
  recorded_at: string;
  withdrawn_at: string | null;
  updated_at: string;
  is_current: boolean;
}>;

export type CurrentConsentRow = Readonly<{
  subject_type: string;
  subject_id: string;
  user_id: string | null;
  account_id: string | null;
  policy_key: string;
  consent_id: string;
  policy_version: string;
  status: "recorded" | "withdrawn";
  recorded_at: string;
  withdrawn_at: string | null;
  updated_at: string;
}>;

export type ConsentListParams = ListParams &
  Readonly<{
    userId?: string;
    accountId?: string;
  }>;

/**
 * Returns the current recorded-or-withdrawn state for `policyKey` and the
 * given subject (user and/or account), or null if none exists. Used by the
 * Terms of Service acceptance gate to compare against the active required
 * version -- see `terms-acceptance.ts`.
 */
export async function findCurrentConsent(
  db: PgQueryable,
  params: Readonly<{ userId?: string | null; accountId?: string | null; policyKey: string }>,
): Promise<CurrentConsentRow | null> {
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

  const result = await db.query<CurrentConsentRow>(
    `SELECT subject_type, subject_id, user_id, account_id, policy_key, consent_id, policy_version,
            status, recorded_at, withdrawn_at, updated_at
     FROM identity_consent_current_states
     WHERE ${conditions.join(" AND ")}
     ORDER BY updated_at DESC, consent_id DESC
     LIMIT 1`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function getConsent(db: PgQueryable, consentId: string): Promise<ConsentRow | null> {
  const result = await db.query<ConsentRow>(
    `SELECT h.*,
            EXISTS (
              SELECT 1
              FROM identity_consent_current_states c
              WHERE c.subject_type = h.subject_type
                AND c.subject_id = CASE WHEN h.subject_type = 'user' THEN h.user_id ELSE h.account_id END
                AND c.policy_key = h.policy_key
                AND c.consent_id = h.consent_id
            ) AS is_current
     FROM identity_consents h
     WHERE h.consent_id = $1`,
    [consentId],
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
    `(SELECT h.*,
             EXISTS (
               SELECT 1
               FROM identity_consent_current_states c
               WHERE c.subject_type = h.subject_type
                 AND c.subject_id = CASE WHEN h.subject_type = 'user' THEN h.user_id ELSE h.account_id END
                 AND c.policy_key = h.policy_key
                 AND c.consent_id = h.consent_id
             ) AS is_current
      FROM identity_consents h) AS consent_history`,
    params,
    ["policy_key", "policy_version", "subject_type"],
    "recorded_at DESC",
    extraConditions,
    extraValues,
  );
  return executeListQuery<ConsentRow>(db, query.countSql, query.listSql, query.countValues, query.listValues);
}
