import type { PgQueryable } from "@chase-sets/event-core-postgres";

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
    agreement.agreement_id,
    agreement.account_id,
    account.display_name AS account_display_name,
    account.account_type,
    agreement.label,
    agreement.marketplace_sales_fee_percentage_bps,
    agreement.marketplace_sales_fee_fixed_amount::text,
    agreement.shipping_allowance_percentage_bps,
    agreement.status,
    agreement.effective_from,
    agreement.effective_until,
    agreement.created_at,
    agreement.updated_at
  FROM commercial_terms_agreement_pages AS agreement
  LEFT JOIN commercial_terms_account_pages AS account
    ON account.account_id = agreement.account_id
`;

export async function listAgreements(db: PgQueryable, params: Readonly<{ limit?: number; offset?: number }> = {}) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>("SELECT COUNT(*) AS count FROM commercial_terms_agreement_pages"),
    db.query<CommercialAgreementRow>(
      `${agreementSelect}
       ORDER BY agreement.updated_at DESC, agreement.agreement_id DESC
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
     WHERE agreement.agreement_id = $1`,
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
       agreement_id,
       event_type,
       actor_user_id,
       status,
       payload,
       effective_from,
       effective_until,
       recorded_at
     FROM commercial_terms_agreement_history
     WHERE agreement_id = $1
     ORDER BY recorded_at DESC, history_id DESC`,
    [agreementId],
  );

  return result.rows;
}

export async function findOverlappingActiveAgreement(db: PgQueryable, params: AgreementWindowCheck) {
  const result = await db.query<{ agreement_id: string }>(
    `SELECT agreement_id
     FROM commercial_terms_agreement_pages
     WHERE account_id = $1
       AND status = 'active'
       AND ($4::text IS NULL OR agreement_id <> $4)
       AND tstzrange(effective_from, COALESCE(effective_until, 'infinity'::timestamptz), '[)')
         && tstzrange($2::timestamptz, COALESCE($3::timestamptz, 'infinity'::timestamptz), '[)')
     LIMIT 1`,
    [params.accountId, params.effectiveFrom, params.effectiveUntil, params.excludeAgreementId ?? null],
  );

  return result.rows[0] ?? null;
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
