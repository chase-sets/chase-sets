import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type PolicyDocumentRow = Readonly<{
  document_id: string;
  policy_key: string;
  context_name: string;
  schema_summary: string;
  status: string;
  value: unknown;
  effective_from: string;
  effective_until: string | null;
  created_at: string;
  updated_at: string;
  history?: readonly PolicyDocumentHistoryRow[];
}>;

export type PolicyDocumentHistoryRow = Readonly<{
  history_id: string;
  event_id: string;
  document_id: string;
  policy_key: string;
  event_type: string;
  actor_user_id: string;
  status: string;
  value: unknown;
  effective_from: string;
  effective_until: string | null;
  recorded_at: string;
}>;

export type PolicyRegistryRow = Readonly<{
  policy_key: string;
  context_name: string;
  schema_summary: string;
  status: string;
  value: unknown;
  effective_from: string;
  effective_until: string | null;
  updated_at: string;
}>;

export type PolicyDocumentWindowCheck = Readonly<{
  policyKey: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  excludeDocumentId?: string | null;
}>;

const policyDocumentSelect = `
  SELECT
    document_id,
    policy_key,
    context_name,
    schema_summary,
    status,
    value,
    effective_from,
    effective_until,
    created_at,
    updated_at
  FROM platform_policy_documents
`;

/**
 * Loads every `active` document row for a policy key -- the resolver's
 * candidate set. Ordered so the resolver can pick the first row whose window
 * covers the requested instant.
 */
export async function listActivePolicyDocuments(db: PgQueryable, policyKey: string) {
  const result = await db.query<PolicyDocumentRow>(
    `${policyDocumentSelect}
     WHERE policy_key = $1
       AND status = 'active'
     ORDER BY effective_from DESC, updated_at DESC, document_id DESC`,
    [policyKey],
  );

  return result.rows;
}

export async function getPolicyDocument(db: PgQueryable, documentId: string) {
  const result = await db.query<PolicyDocumentRow>(
    `${policyDocumentSelect}
     WHERE document_id = $1`,
    [documentId],
  );
  const document = result.rows[0];
  if (!document) {
    return null;
  }

  return {
    ...document,
    history: await listPolicyDocumentHistory(db, documentId),
  };
}

export async function listPolicyDocumentHistory(db: PgQueryable, documentId: string) {
  const result = await db.query<PolicyDocumentHistoryRow>(
    `SELECT
       history_id::text AS history_id,
       event_id,
       document_id,
       policy_key,
       event_type,
       actor_user_id,
       status,
       value,
       effective_from,
       effective_until,
       recorded_at
     FROM platform_policy_document_history
     WHERE document_id = $1
     ORDER BY recorded_at DESC, history_id DESC`,
    [documentId],
  );

  return result.rows;
}

export async function findOverlappingActivePolicyDocument(db: PgQueryable, params: PolicyDocumentWindowCheck) {
  const result = await db.query<{ document_id: string }>(
    `SELECT document_id
     FROM platform_policy_documents
     WHERE policy_key = $1
       AND status = 'active'
       AND ($4::text IS NULL OR document_id <> $4)
       AND tstzrange(effective_from, COALESCE(effective_until, 'infinity'::timestamptz), '[)')
         && tstzrange($2::timestamptz, COALESCE($3::timestamptz, 'infinity'::timestamptz), '[)')
     LIMIT 1`,
    [params.policyKey, params.effectiveFrom, params.effectiveUntil, params.excludeDocumentId ?? null],
  );

  return result.rows[0] ?? null;
}

/**
 * The registry read model: one row per declared policy key, derived from
 * whatever documents have actually been written -- not a separately
 * authored catalog. This scopes to the calling context's own database,
 * matching how each context owns its own copy of these tables.
 */
export async function listPolicyRegistry(db: PgQueryable) {
  const result = await db.query<PolicyRegistryRow>(
    `SELECT DISTINCT ON (policy_key)
       policy_key,
       context_name,
       schema_summary,
       status,
       value,
       effective_from,
       effective_until,
       updated_at
     FROM platform_policy_documents
     ORDER BY policy_key, effective_from DESC, updated_at DESC`,
  );

  return result.rows;
}
