import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  applyFeeFormula,
  assert,
  normalizeMoneyAmount,
  subtractMoneyAmounts,
  type CommercialAccountType,
} from "../../../support/runtime-support/common";

export type ResolvedCommercialTerms = Readonly<{
  accountId: string;
  accountType: CommercialAccountType;
  basisAmount: string;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps: number;
  scheduleId: string | null;
  agreementId: string | null;
  resolvedAt: string;
}>;

export type CommercialTermsResolver = Readonly<{
  resolveListingTerms: (params: Readonly<{
    accountId: string;
    amount: string;
    effectiveAt?: string;
  }>) => Promise<ResolvedCommercialTerms>;
  resolveOrderTerms: (params: Readonly<{
    accountId: string;
    amount: string;
    effectiveAt?: string;
  }>) => Promise<ResolvedCommercialTerms>;
}>;

type ProjectedAccount = Readonly<{
  account_id: string;
  account_type: CommercialAccountType;
  status: string;
}>;

type ActiveSchedule = Readonly<{
  schedule_id: string;
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  shipping_allowance_percentage_bps: number;
}>;

type ActiveAgreement = Readonly<{
  agreement_id: string;
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  shipping_allowance_percentage_bps: number;
}>;

async function getProjectedAccount(db: PgQueryable, accountId: string) {
  const result = await db.query<ProjectedAccount>(
    `SELECT account_id, account_type, status
     FROM commercial_terms_account_pages
     WHERE account_id = $1`,
    [accountId],
  );

  return result.rows[0] ?? null;
}

async function getActiveSchedule(
  db: PgQueryable,
  accountType: CommercialAccountType,
  effectiveAt: string,
) {
  const result = await db.query<ActiveSchedule>(
    `SELECT
       schedule_id,
       marketplace_sales_fee_percentage_bps,
       marketplace_sales_fee_fixed_amount::text,
       shipping_allowance_percentage_bps
     FROM commercial_terms_schedule_pages
     WHERE account_type = $1
       AND status = 'active'
       AND effective_from <= $2
       AND (effective_until IS NULL OR effective_until > $2)
     ORDER BY effective_from DESC, updated_at DESC, schedule_id DESC
     LIMIT 1`,
    [accountType, effectiveAt],
  );

  return result.rows[0] ?? null;
}

async function getActiveAgreement(
  db: PgQueryable,
  accountId: string,
  effectiveAt: string,
) {
  const result = await db.query<ActiveAgreement>(
    `SELECT
       agreement_id,
       marketplace_sales_fee_percentage_bps,
       marketplace_sales_fee_fixed_amount::text,
       shipping_allowance_percentage_bps
     FROM commercial_terms_agreement_pages
     WHERE account_id = $1
       AND status = 'active'
       AND effective_from <= $2
       AND (effective_until IS NULL OR effective_until > $2)
     ORDER BY effective_from DESC, updated_at DESC, agreement_id DESC
     LIMIT 1`,
    [accountId, effectiveAt],
  );

  return result.rows[0] ?? null;
}

async function resolveTerms(
  db: PgQueryable,
  params: Readonly<{
    accountId: string;
    amount: string;
    effectiveAt?: string;
  }>,
): Promise<ResolvedCommercialTerms> {
  const effectiveAt = params.effectiveAt ?? new Date().toISOString();
  const amount = normalizeMoneyAmount(params.amount, {
    fieldName: "Commercial terms amount",
    allowZero: true,
  });
  const account = await getProjectedAccount(db, params.accountId);
  assert(account, `Account ${params.accountId} is not available for commercial terms.`);
  assert(account.status === "active", `Account ${params.accountId} is not active.`);

  const [schedule, agreement] = await Promise.all([
    getActiveSchedule(db, account.account_type, effectiveAt),
    getActiveAgreement(db, params.accountId, effectiveAt),
  ]);

  assert(
    schedule || agreement,
    `No active commercial terms were found for account ${params.accountId}.`,
  );

  const marketplaceSalesFeeUnitAmount = applyFeeFormula(amount, {
    percentageBps:
      agreement?.marketplace_sales_fee_percentage_bps ?? schedule?.marketplace_sales_fee_percentage_bps ?? 0,
    fixedAmount:
      agreement?.marketplace_sales_fee_fixed_amount ?? schedule?.marketplace_sales_fee_fixed_amount ?? "0.00",
  });

  return {
    accountId: params.accountId,
    accountType: account.account_type,
    basisAmount: amount,
    marketplaceSalesFeeUnitAmount,
    sellerNetUnitAmount: subtractMoneyAmounts(amount, marketplaceSalesFeeUnitAmount),
    shippingAllowancePercentageBps:
      agreement?.shipping_allowance_percentage_bps ??
      schedule?.shipping_allowance_percentage_bps ??
      500,
    scheduleId: schedule?.schedule_id ?? null,
    agreementId: agreement?.agreement_id ?? null,
    resolvedAt: effectiveAt,
  };
}

export function createCommercialTermsResolver(
  deps: Readonly<{ db: PgQueryable }>,
): CommercialTermsResolver {
  return {
    resolveListingTerms: (params) => resolveTerms(deps.db, params),
    resolveOrderTerms: (params) => resolveTerms(deps.db, params),
  };
}

export function createNoopCommercialTermsResolver(): CommercialTermsResolver {
  const resolve = async (params: Readonly<{ accountId: string; amount: string; effectiveAt?: string }>) => {
    const amount = normalizeMoneyAmount(params.amount, {
      fieldName: "Commercial terms amount",
      allowZero: true,
    });

    return {
      accountId: params.accountId,
      accountType: "business" as const,
      basisAmount: amount,
      marketplaceSalesFeeUnitAmount: "0.00",
      sellerNetUnitAmount: amount,
      shippingAllowancePercentageBps: 500,
      scheduleId: null,
      agreementId: null,
      resolvedAt: params.effectiveAt ?? new Date().toISOString(),
    };
  };

  return {
    resolveListingTerms: resolve,
    resolveOrderTerms: resolve,
  };
}
