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
 * Returns the current recorded-or-withdrawn state for `policyKey` held by this
 * user OR carried in this account's context, or null if none exists. Used by
 * the pre-bundle Terms of Service acceptance gate -- see `terms-acceptance.ts`.
 *
 * The disjunction is this port's shipped question and is deliberately left
 * alone: Settlement asks it with an account and no user, to decide whether an
 * account-scoped wallet balance may be spent, and answers it from the account
 * context recorded alongside a member's Consent. Narrowing it to one exact
 * subject would silently close that gate for every account.
 *
 * It is therefore NOT the rule for Consent Bundle acceptance, which asks whose
 * Consent this is and is answered by `findCurrentConsentsForPolicyKeys` on the
 * exact `(subject_type, subject_id)` the bundle declares. The two functions
 * answer different questions and must not be collapsed into one.
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
 * held by ONE exact subject, in one round trip -- the per-bundle read the
 * Consent Bundle acceptance resolver composes over.
 *
 * The subject is `(subject_type, subject_id)`, which with `policy_key` is the
 * projection's unique key, so each requested key matches at most one row and no
 * tie-break is needed. It is deliberately NOT "this user or this account": a
 * disjunction over the `user_id` / `account_id` companion columns lets one
 * principal's Consent answer for another principal that merely shares an
 * account, which is the whole reason a Consent fact carries a subject at all.
 * The companion columns are recorded context and are never matched on here.
 *
 * The requested keys enter as a joined relation rather than an `IN` list so the
 * result can be aligned with the caller's ordered bundle without a second pass,
 * and `WITH ORDINALITY` makes that alignment the query's own guarantee rather
 * than an accident of the join order. `policy_key` exists on both sides of that
 * join, so every column reference on either side is table-qualified: an
 * unqualified `policy_key` here would be ambiguous at best and silently bind to
 * the wrong relation at worst. Keys with no consent fact simply produce no row;
 * absence is the caller's fail-closed "not accepted", never a row invented here.
 */
export async function findCurrentConsentsForPolicyKeys(
  db: PgQueryable,
  params: Readonly<{ subjectType: string; subjectId: string; policyKeys: readonly string[] }>,
): Promise<readonly RequestedCurrentConsentRow[]> {
  if (!params.subjectType || !params.subjectId) {
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
     FROM unnest($1::text[]) WITH ORDINALITY AS requested(policy_key, request_index)
     JOIN identity_consent_current_states AS matched
       ON matched.policy_key = requested.policy_key
      AND matched.subject_type = $2
      AND matched.subject_id = $3
     ORDER BY requested.request_index`,
    [[...params.policyKeys], params.subjectType, params.subjectId],
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
