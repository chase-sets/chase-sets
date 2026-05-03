import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type CommercialAgreementRow = Readonly<{
  agreement_id: string;
  account_id: string;
  account_display_name: string | null;
  account_type: string | null;
  label: string;
  marketplace_fee_percentage_bps: number;
  marketplace_fee_fixed_amount: string;
  status: string;
  effective_from: string;
  effective_until: string | null;
  created_at: string;
  updated_at: string;
}>;

const agreementSelect = `
  SELECT
    agreement.agreement_id,
    agreement.account_id,
    account.display_name AS account_display_name,
    account.account_type,
    agreement.label,
    agreement.marketplace_fee_percentage_bps,
    agreement.marketplace_fee_fixed_amount::text,
    agreement.status,
    agreement.effective_from,
    agreement.effective_until,
    agreement.created_at,
    agreement.updated_at
  FROM commercial_terms_agreement_pages AS agreement
  LEFT JOIN commercial_terms_account_pages AS account
    ON account.account_id = agreement.account_id
`;

export async function listAgreements(
  db: PgQueryable,
  params: Readonly<{ limit?: number; offset?: number }> = {},
) {
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
  return result.rows[0] ?? null;
}
