import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PostagePolicy } from "@chase-sets/product-measures";

export type PostagePolicyRow = Readonly<{
  policy_id: string;
  label: string;
  status: string;
  policy_version: string;
  payload: PostagePolicy;
  effective_from: string;
  effective_until: string | null;
  activation_reason: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  retired_at: string | null;
}>;

export type PostagePolicyHistoryRow = Readonly<{
  history_id: string;
  policy_id: string;
  event_type: string;
  actor_user_id: string;
  reason: string | null;
  status: string;
  policy_version: string;
  payload: PostagePolicy;
  effective_from: string;
  effective_until: string | null;
  recorded_at: string;
}>;

export type PostagePolicyComparisonRow = Readonly<{
  field: string;
  activeValue: string;
  candidateValue: string;
}>;

export type PostagePolicyDetailRow = PostagePolicyRow &
  Readonly<{
    history: readonly PostagePolicyHistoryRow[];
    activeComparison: readonly PostagePolicyComparisonRow[];
  }>;

const selectPostagePolicySql = `
  SELECT
    policy_id,
    label,
    status,
    policy_version,
    payload,
    effective_from,
    effective_until,
    activation_reason,
    created_by_user_id,
    created_at,
    updated_at,
    activated_at,
    retired_at
  FROM ordering_postage_policy_pages
`;

const comparableFields = [
  "policyVersion",
  "maxLetterUnits",
  "maxLetterWeightOunces",
  "maxLetterThicknessInches",
  "maxLetterDeclaredValueAmount",
  "letterEnvelopeWeightOunces",
  "parcelPackagingWeightOunces",
  "parcelRequiredShippingOptions",
  "letterRequiredPhysicalFlags",
  "parcelRequiredPhysicalFlags",
  "signatureRequiredShippingOptions",
  "signatureRequiredDeclaredValueAmount",
  "signatureRequiredPhysicalFlags",
  "insuranceRequiredDeclaredValueAmount",
] as const satisfies readonly (keyof PostagePolicy)[];

function formatComparableValue(value: unknown) {
  return Array.isArray(value) ? value.join(", ") || "none" : value == null ? "none" : String(value);
}

function comparePostagePolicies(active: PostagePolicy | null, candidate: PostagePolicy) {
  if (!active) {
    return [];
  }

  return comparableFields.flatMap((field) => {
    const activeValue = formatComparableValue(active[field]);
    const candidateValue = formatComparableValue(candidate[field]);
    return activeValue === candidateValue
      ? []
      : [
          {
            field,
            activeValue,
            candidateValue,
          },
        ];
  });
}

export async function listPostagePolicies(db: PgQueryable, params: Readonly<{ limit?: number; offset?: number }> = {}) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>("SELECT COUNT(*) AS count FROM ordering_postage_policy_pages"),
    db.query<PostagePolicyRow>(
      `${selectPostagePolicySql}
       ORDER BY status ASC, effective_from DESC, updated_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getPostagePolicy(db: PgQueryable, policyId: string): Promise<PostagePolicyDetailRow | null> {
  const result = await db.query<PostagePolicyRow>(
    `${selectPostagePolicySql}
     WHERE policy_id = $1`,
    [policyId],
  );
  const policy = result.rows[0];
  if (!policy) {
    return null;
  }

  const [historyResult, activePolicy] = await Promise.all([
    db.query<PostagePolicyHistoryRow>(
      `SELECT
         history_id::text,
         policy_id,
         event_type,
         actor_user_id,
         reason,
         status,
         policy_version,
         payload,
         effective_from,
         effective_until,
         recorded_at
       FROM ordering_postage_policy_history
       WHERE policy_id = $1
       ORDER BY recorded_at DESC, history_id DESC`,
      [policyId],
    ),
    getActivePostagePolicy(db),
  ]);

  return {
    ...policy,
    history: historyResult.rows,
    activeComparison:
      activePolicy && activePolicy.policy_id !== policy.policy_id
        ? comparePostagePolicies(activePolicy.payload, policy.payload)
        : [],
  };
}

export async function getActivePostagePolicy(db: PgQueryable, effectiveAt = new Date().toISOString()) {
  const result = await db.query<PostagePolicyRow>(
    `${selectPostagePolicySql}
     WHERE status = 'active'
       AND effective_from <= $1
       AND (effective_until IS NULL OR effective_until > $1)
     ORDER BY activated_at DESC NULLS LAST, updated_at DESC
     LIMIT 1`,
    [effectiveAt],
  );
  return result.rows[0] ?? null;
}
