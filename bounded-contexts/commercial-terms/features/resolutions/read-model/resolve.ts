import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { recordPlatformPostWriteConsistencyEvent } from "@chase-sets/platform-runtime/post-write-consistency";
import {
  applyFeeFormula,
  assert,
  DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  normalizeMoneyAmount,
  subtractMoneyAmounts,
  type CommercialAccountType,
} from "../../../support/runtime-support/common";
import {
  commercialTermsAgreementPolicyKey,
  commercialTermsSchedulePolicyKey,
} from "../../../support/runtime-support/terms-policy";

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

export type ResolvedPublicStandardCommercialTerms = Readonly<{
  accountType: CommercialAccountType;
  basisAmount: string;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps: number;
  scheduleId: string;
  scheduleLabel: string;
  scheduleUpdatedAt: string;
  resolvedAt: string;
}>;

export type CommercialTermsResolver = Readonly<{
  resolveListingTerms: (
    params: Readonly<{
      accountId: string;
      amount: string;
      effectiveAt?: string;
    }>,
  ) => Promise<ResolvedCommercialTerms>;
  resolveOrderTerms: (
    params: Readonly<{
      accountId: string;
      amount: string;
      effectiveAt?: string;
    }>,
  ) => Promise<ResolvedCommercialTerms>;
  resolvePublicStandardListingTerms: (
    params: Readonly<{
      accountType?: CommercialAccountType;
      amount: string;
      effectiveAt?: string;
    }>,
  ) => Promise<ResolvedPublicStandardCommercialTerms>;
}>;

type ProjectedAccount = Readonly<{
  account_id: string;
  account_type: CommercialAccountType;
  status: string;
}>;

export type CommercialTermsAccountSource = Readonly<{
  getAccount: (accountId: string) => Promise<ProjectedAccount | null>;
}>;

type CommercialTermsAccountSourceOutcome = "projection_hit" | "fallback_used" | "fallback_failed";

const accountSourceFallbackTelemetry = {
  boundedContextName: "commercial-terms",
  sourceContextName: "identity",
  projectionName: "commercial-terms-account-projection",
  readModelTable: "commercial_terms_account_pages",
  fallbackId: "commercial-terms.identity-account-source-fresh-account",
  fallbackCategory: "host-owned bridge",
  surface: "commercial-terms-resolution",
  strategy: "projection-fallback",
} as const;

type ActiveSchedule = Readonly<{
  schedule_id: string;
  label: string;
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  shipping_allowance_percentage_bps: number;
  updated_at: string;
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

function isCommercialAccountType(value: unknown): value is CommercialAccountType {
  return value === "personal" || value === "business" || value === "enterprise";
}

function recordAccountSourceFallbackOutcome(outcome: CommercialTermsAccountSourceOutcome): void {
  recordPlatformPostWriteConsistencyEvent({
    ...accountSourceFallbackTelemetry,
    outcome,
  });
}

async function getCommercialTermsAccount(
  db: PgQueryable,
  accountSource: CommercialTermsAccountSource | undefined,
  accountId: string,
) {
  const projectedAccount = await getProjectedAccount(db, accountId);
  if (projectedAccount) {
    recordAccountSourceFallbackOutcome("projection_hit");
    return projectedAccount;
  }

  const fallbackAccount = (await accountSource?.getAccount(accountId)) ?? null;
  recordAccountSourceFallbackOutcome(
    fallbackAccount?.status === "active" && isCommercialAccountType(fallbackAccount.account_type)
      ? "fallback_used"
      : "fallback_failed",
  );
  return fallbackAccount;
}

/**
 * Schedules and agreements resolve directly against the shared
 * `platform_policy_documents` table (see `infrastructure/platform-policy/schema.ts`).
 * This stays raw SQL rather than the shared `PolicyResolver` because that
 * resolver always falls back to a compiled default when no document
 * matches; resolution here must fail closed when no active schedule or
 * agreement exists, exactly as it did before convergence.
 */
async function getActiveSchedule(db: PgQueryable, accountType: CommercialAccountType, effectiveAt: string) {
  const result = await db.query<ActiveSchedule>(
    `SELECT
       document_id AS schedule_id,
       value->>'label' AS label,
       (value->>'marketplaceSalesFeePercentageBps')::integer AS marketplace_sales_fee_percentage_bps,
       value->>'marketplaceSalesFeeFixedAmount' AS marketplace_sales_fee_fixed_amount,
       (value->>'shippingAllowancePercentageBps')::integer AS shipping_allowance_percentage_bps,
       updated_at::text AS updated_at
     FROM platform_policy_documents
     WHERE policy_key = $1
       AND status = 'active'
       AND effective_from <= $2
       AND (effective_until IS NULL OR effective_until > $2)
     ORDER BY effective_from DESC, updated_at DESC, document_id DESC
     LIMIT 1`,
    [commercialTermsSchedulePolicyKey(accountType), effectiveAt],
  );

  return result.rows[0] ?? null;
}

async function getActiveAgreement(db: PgQueryable, accountId: string, effectiveAt: string) {
  const result = await db.query<ActiveAgreement>(
    `SELECT
       document_id AS agreement_id,
       (value->>'marketplaceSalesFeePercentageBps')::integer AS marketplace_sales_fee_percentage_bps,
       value->>'marketplaceSalesFeeFixedAmount' AS marketplace_sales_fee_fixed_amount,
       (value->>'shippingAllowancePercentageBps')::integer AS shipping_allowance_percentage_bps
     FROM platform_policy_documents
     WHERE policy_key = $1
       AND status = 'active'
       AND effective_from <= $2
       AND (effective_until IS NULL OR effective_until > $2)
     ORDER BY effective_from DESC, updated_at DESC, document_id DESC
     LIMIT 1`,
    [commercialTermsAgreementPolicyKey(accountId), effectiveAt],
  );

  return result.rows[0] ?? null;
}

async function resolveTerms(
  db: PgQueryable,
  accountSource: CommercialTermsAccountSource | undefined,
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
  const account = await getCommercialTermsAccount(db, accountSource, params.accountId);
  assert(account, `Account ${params.accountId} is not available for commercial terms.`);
  assert(account.status === "active", `Account ${params.accountId} is not active.`);
  assert(isCommercialAccountType(account.account_type), `Account ${params.accountId} is missing account type.`);

  const [schedule, agreement] = await Promise.all([
    getActiveSchedule(db, account.account_type, effectiveAt),
    getActiveAgreement(db, params.accountId, effectiveAt),
  ]);

  assert(schedule || agreement, `No active commercial terms were found for account ${params.accountId}.`);

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
      DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
    scheduleId: schedule?.schedule_id ?? null,
    agreementId: agreement?.agreement_id ?? null,
    resolvedAt: effectiveAt,
  };
}

async function resolvePublicStandardTerms(
  db: PgQueryable,
  params: Readonly<{
    accountType?: CommercialAccountType;
    amount: string;
    effectiveAt?: string;
  }>,
): Promise<ResolvedPublicStandardCommercialTerms> {
  const accountType = params.accountType ?? "personal";
  const effectiveAt = params.effectiveAt ?? new Date().toISOString();
  const amount = normalizeMoneyAmount(params.amount, {
    fieldName: "Commercial terms amount",
    allowZero: true,
  });
  const schedule = await getActiveSchedule(db, accountType, effectiveAt);
  assert(schedule, `No active public standard commercial terms were found for ${accountType} accounts.`);

  const marketplaceSalesFeeUnitAmount = applyFeeFormula(amount, {
    percentageBps: schedule.marketplace_sales_fee_percentage_bps,
    fixedAmount: schedule.marketplace_sales_fee_fixed_amount,
  });

  return {
    accountType,
    basisAmount: amount,
    marketplaceSalesFeeUnitAmount,
    sellerNetUnitAmount: subtractMoneyAmounts(amount, marketplaceSalesFeeUnitAmount),
    shippingAllowancePercentageBps: schedule.shipping_allowance_percentage_bps,
    scheduleId: schedule.schedule_id,
    scheduleLabel: schedule.label,
    scheduleUpdatedAt: schedule.updated_at,
    resolvedAt: effectiveAt,
  };
}

export function createCommercialTermsResolver(
  deps: Readonly<{ db: PgQueryable; accountSource?: CommercialTermsAccountSource }>,
): CommercialTermsResolver {
  return {
    resolveListingTerms: (params) => resolveTerms(deps.db, deps.accountSource, params),
    resolveOrderTerms: (params) => resolveTerms(deps.db, deps.accountSource, params),
    resolvePublicStandardListingTerms: (params) => resolvePublicStandardTerms(deps.db, params),
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
      shippingAllowancePercentageBps: DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
      scheduleId: null,
      agreementId: null,
      resolvedAt: params.effectiveAt ?? new Date().toISOString(),
    };
  };

  return {
    resolveListingTerms: resolve,
    resolveOrderTerms: resolve,
    resolvePublicStandardListingTerms: async (params) => {
      const amount = normalizeMoneyAmount(params.amount, {
        fieldName: "Commercial terms amount",
        allowZero: true,
      });

      return {
        accountType: params.accountType ?? "personal",
        basisAmount: amount,
        marketplaceSalesFeeUnitAmount: "0.00",
        sellerNetUnitAmount: amount,
        shippingAllowancePercentageBps: DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
        scheduleId: "noop_public_standard",
        scheduleLabel: "Standard seller terms",
        scheduleUpdatedAt: params.effectiveAt ?? new Date().toISOString(),
        resolvedAt: params.effectiveAt ?? new Date().toISOString(),
      };
    },
  };
}
