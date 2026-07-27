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

export type RequestedCurrentConsentRow = CurrentConsentRow &
  Readonly<{
    /** The policy key the caller asked about, echoed from the request side of the join. */
    requested_policy_key: string;
  }>;

/**
 * Returns the current recorded-or-withdrawn state for each requested policy key
 * and the given subject, in one round trip -- the per-bundle read the Consent
 * Bundle acceptance resolver composes over `findCurrentConsent`'s single-policy
 * rule.
 *
 * The requested keys enter as a joined relation rather than an `IN` list so the
 * result can be aligned with the caller's ordered bundle without a second pass.
 * `policy_key` exists on both sides of that join, so every column reference on
 * either side is table-qualified: an unqualified `policy_key` here would be
 * ambiguous at best and silently bind to the wrong relation at worst. Keys with
 * no consent fact simply produce no row; absence is the caller's fail-closed
 * "not accepted", never a row invented here.
 */
export async function findCurrentConsentsForPolicyKeys(
  db: PgQueryable,
  params: Readonly<{ userId?: string | null; accountId?: string | null; policyKeys: readonly string[] }>,
): Promise<readonly RequestedCurrentConsentRow[]> {
  if (!params.userId && !params.accountId) {
    return [];
  }
  if (params.policyKeys.length === 0) {
    return [];
  }

  const result = await db.query<RequestedCurrentConsentRow>(
    `SELECT requested.policy_key AS requested_policy_key,
            matched.subject_type,
            matched.subject_id,
            matched.user_id,
            matched.account_id,
            matched.policy_key,
            matched.consent_id,
            matched.policy_version,
            matched.status,
            matched.recorded_at,
            matched.withdrawn_at,
            matched.updated_at
     FROM unnest($1::text[]) AS requested(policy_key)
     JOIN LATERAL (
       SELECT current_state.subject_type,
              current_state.subject_id,
              current_state.user_id,
              current_state.account_id,
              current_state.policy_key,
              current_state.consent_id,
              current_state.policy_version,
              current_state.status,
              current_state.recorded_at,
              current_state.withdrawn_at,
              current_state.updated_at
       FROM identity_consent_current_states AS current_state
       WHERE current_state.policy_key = requested.policy_key
         AND (
           ($2::text IS NOT NULL AND current_state.user_id = $2)
           OR ($3::text IS NOT NULL AND current_state.account_id = $3)
         )
       ORDER BY current_state.updated_at DESC, current_state.consent_id DESC
       LIMIT 1
     ) AS matched ON TRUE`,
    [[...params.policyKeys], params.userId ?? null, params.accountId ?? null],
  );
  return result.rows;
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
