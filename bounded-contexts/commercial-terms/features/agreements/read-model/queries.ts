import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { findOverlappingActivePolicyDocument } from "@chase-sets/platform-policy/queries";
import { commercialTermsAgreementPolicyKey } from "../../../support/runtime-support/terms-policy";

/**
 * Agreements read against the shared `platform_policy_documents` /
 * `platform_policy_document_history` tables instead of the bespoke,
 * now-dropped per-agreement read-model table that preceded the
 * platform-policy convergence (retirement migration:
 * `unlogged-projection-migrations.ts`). Row shapes below are unchanged from
 * the pre-convergence bespoke projection; the targeting field (`account_id`)
 * and fee terms are extracted out of the opaque `value` jsonb column set by
 * `terms-policy.ts`'s agreement policy value shape.
 */

export type CommercialAgreementRow = Readonly<{
  agreement_id: string;
  account_id: string;
  account_display_name: string | null;
  account_type: string | null;
  label: string;
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  shipping_allowance_percentage_bps: number;
  status: string;
  effective_from: string;
  effective_until: string | null;
  created_at: string;
  updated_at: string;
  history?: readonly CommercialAgreementHistoryRow[];
}>;

export type CommercialAgreementHistoryRow = Readonly<{
  history_id: string;
  event_id: string;
  agreement_id: string;
  event_type: string;
  actor_user_id: string;
  status: string;
  payload: Record<string, unknown>;
  effective_from: string;
  effective_until: string | null;
  recorded_at: string;
}>;

export type AgreementWindowCheck = Readonly<{
  accountId: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  excludeAgreementId?: string | null;
}>;

const agreementSelect = `
  SELECT
    agreement.document_id AS agreement_id,
    agreement.value->>'accountId' AS account_id,
    account.display_name AS account_display_name,
    account.account_type,
    agreement.value->>'label' AS label,
    (agreement.value->>'marketplaceSalesFeePercentageBps')::integer AS marketplace_sales_fee_percentage_bps,
    agreement.value->>'marketplaceSalesFeeFixedAmount' AS marketplace_sales_fee_fixed_amount,
    (agreement.value->>'shippingAllowancePercentageBps')::integer AS shipping_allowance_percentage_bps,
    agreement.status,
    agreement.effective_from,
    agreement.effective_until,
    agreement.created_at,
    agreement.updated_at
  FROM platform_policy_documents AS agreement
  LEFT JOIN commercial_terms_account_pages AS account
    ON account.account_id = agreement.value->>'accountId'
`;

export async function listAgreements(db: PgQueryable, params: Readonly<{ limit?: number; offset?: number }> = {}) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM platform_policy_documents WHERE policy_key LIKE 'commercial-terms.agreement.%'`,
    ),
    db.query<CommercialAgreementRow>(
      `${agreementSelect}
       WHERE agreement.policy_key LIKE 'commercial-terms.agreement.%'
       ORDER BY agreement.updated_at DESC, agreement.document_id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getAgreement(db: PgQueryable, agreementId: string) {
  const result = await db.query<CommercialAgreementRow>(
    `${agreementSelect}
     WHERE agreement.document_id = $1
       AND agreement.policy_key LIKE 'commercial-terms.agreement.%'`,
    [agreementId],
  );
  const agreement = result.rows[0];
  if (!agreement) {
    return null;
  }

  return {
    ...agreement,
    history: await listAgreementHistory(db, agreementId),
  };
}

export async function listAgreementHistory(db: PgQueryable, agreementId: string) {
  const result = await db.query<CommercialAgreementHistoryRow>(
    `SELECT
       history_id::text AS history_id,
       event_id,
       document_id AS agreement_id,
       event_type,
       actor_user_id,
       status,
       value AS payload,
       effective_from,
       effective_until,
       recorded_at
     FROM platform_policy_document_history
     WHERE document_id = $1
     ORDER BY recorded_at DESC, history_id DESC`,
    [agreementId],
  );

  return result.rows;
}

export async function findOverlappingActiveAgreement(db: PgQueryable, params: AgreementWindowCheck) {
  const overlap = await findOverlappingActivePolicyDocument(db, {
    policyKey: commercialTermsAgreementPolicyKey(params.accountId),
    effectiveFrom: params.effectiveFrom,
    effectiveUntil: params.effectiveUntil,
    excludeDocumentId: params.excludeAgreementId,
  });

  return overlap ? { agreement_id: overlap.document_id } : null;
}

export async function getCommercialTermsAccountReference(db: PgQueryable, accountId: string) {
  const result = await db.query<{ account_id: string }>(
    `SELECT account_id
     FROM commercial_terms_account_pages
     WHERE account_id = $1
     LIMIT 1`,
    [accountId],
  );

  return result.rows[0] ?? null;
}

export type CommercialTermsAccountOption = Readonly<{
  account_id: string;
  display_name: string;
  account_type: string;
}>;

export async function listCommercialTermsAccountOptions(db: PgQueryable) {
  const result = await db.query<CommercialTermsAccountOption>(
    `SELECT account_id, display_name, account_type
     FROM commercial_terms_account_pages
     WHERE status = 'active'
     ORDER BY display_name ASC, account_id ASC
     LIMIT 250`,
  );
  return result.rows;
}
