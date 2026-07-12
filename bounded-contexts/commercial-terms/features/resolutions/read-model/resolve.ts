import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { recordPlatformPostWriteConsistencyEvent } from "@chase-sets/platform-runtime/post-write-consistency";
import { centsToMoneyAmount, moneyToCents } from "@chase-sets/primitives/money";
import {
  applyFeeFormula,
  assert,
  DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  normalizeMoneyAmount,
  subtractMoneyAmounts,
  type CommercialAccountType,
} from "../../../support/runtime-support/common";
import { commercialTermsAgreementPolicyKey } from "../../../support/runtime-support/terms-policy";
import {
  MARKETPLACE_SALES_FEE_SCHEDULE_POLICY_KEY,
  quoteMarketplaceSalesFee,
} from "../../marketplace-sales-fee/domain/policy";

export type ResolvedCommercialTerms = Readonly<{
  accountId: string;
  accountType: CommercialAccountType;
  basisAmount: string;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  marketplaceSalesFeeCapAmount: string | null;
  shippingAllowancePercentageBps: number;
  scheduleId: string | null;
  agreementId: string | null;
  resolvedAt: string;
}>;

export type LockedMarketplaceFeeTerms = Readonly<{
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  marketplaceSalesFeeCapAmount: string | null;
}>;

/** Requotes a listing at its recorded terms without consulting current policy. */
export function quoteLockedMarketplaceFeeTerms(terms: LockedMarketplaceFeeTerms, rawAmount: string) {
  const amount = normalizeMoneyAmount(rawAmount, { fieldName: "Commercial terms amount", allowZero: true });
  const uncapped = applyFeeFormula(amount, {
    percentageBps: terms.marketplaceSalesFeePercentageBps,
    fixedAmount: terms.marketplaceSalesFeeFixedAmount,
  });
  const marketplaceSalesFeeUnitAmount =
    terms.marketplaceSalesFeeCapAmount !== null &&
    moneyToCents(uncapped) > moneyToCents(terms.marketplaceSalesFeeCapAmount)
      ? centsToMoneyAmount(moneyToCents(terms.marketplaceSalesFeeCapAmount))
      : uncapped;

  return {
    basisAmount: amount,
    marketplaceSalesFeeUnitAmount,
    sellerNetUnitAmount: subtractMoneyAmounts(amount, marketplaceSalesFeeUnitAmount),
  };
}

/**
 * A per-account listing-terms session, part of the m113 repricing-at-scale
 * throughput lane: the account's active schedule/agreement resolved ONCE,
 * with `quote` applying
 * the SAME `applyFeeFormula` code path as `resolveListingTerms` locally
 * (pure, synchronous, no DB) for as many prices as the caller needs -- so a
 * bulk caller pays one resolution instead of one per listing, and every
 * `quote(amount)` result is byte-identical to what `resolveListingTerms`
 * would have returned for that amount at `resolvedAt`. `scheduleId` and
 * `agreementId` are the session's revision identity: a caller processing a
 * long-running batch in chunks can open a fresh session between chunks and
 * compare identity to detect a mid-run schedule/agreement revision.
 */
export type ResolvedListingTermsSession = Readonly<{
  accountId: string;
  accountType: CommercialAccountType;
  scheduleId: string | null;
  agreementId: string | null;
  resolvedAt: string;
  quote: (amount: string) => ResolvedCommercialTerms;
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
  openListingTermsSession: (
    params: Readonly<{
      accountId: string;
      effectiveAt?: string;
    }>,
  ) => Promise<ResolvedListingTermsSession>;
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
  marketplace_sales_fee_cap_amount: string;
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
async function getActiveSchedule(db: PgQueryable, effectiveAt: string) {
  const result = await db.query<ActiveSchedule>(
    `SELECT
       document_id AS schedule_id,
       value->>'label' AS label,
       (value->>'marketplaceSalesFeePercentageBps')::integer AS marketplace_sales_fee_percentage_bps,
       value->>'marketplaceSalesFeeFixedAmount' AS marketplace_sales_fee_fixed_amount,
       value->>'marketplaceSalesFeeCapAmount' AS marketplace_sales_fee_cap_amount,
       (value->>'shippingAllowancePercentageBps')::integer AS shipping_allowance_percentage_bps,
       updated_at::text AS updated_at
     FROM platform_policy_documents
     WHERE policy_key = $1
       AND status = 'active'
       AND effective_from <= $2
       AND (effective_until IS NULL OR effective_until > $2)
     ORDER BY effective_from DESC, updated_at DESC, document_id DESC
     LIMIT 1`,
    [MARKETPLACE_SALES_FEE_SCHEDULE_POLICY_KEY, effectiveAt],
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

/**
 * The account's resolved fee formula, independent of any specific price --
 * everything `resolveTerms` needs to compute a quote EXCEPT the amount.
 * Extracted so a listing-terms session (`openListingTermsSession`) can
 * resolve this ONCE and apply it locally to many prices, while a
 * single-price call (`resolveTerms`) resolves it and applies it once, both
 * through the exact same `quoteFromListingTermsBasis` code path -- the
 * guarantee that session quotes are byte-identical to individual ones.
 */
type ListingTermsBasis = Readonly<{
  accountId: string;
  accountType: CommercialAccountType;
  scheduleId: string | null;
  agreementId: string | null;
  resolvedAt: string;
  percentageBps: number;
  fixedAmount: string;
  capAmount: string | null;
  shippingAllowancePercentageBps: number;
}>;

async function resolveListingTermsBasis(
  db: PgQueryable,
  accountSource: CommercialTermsAccountSource | undefined,
  params: Readonly<{
    accountId: string;
    effectiveAt?: string;
  }>,
): Promise<ListingTermsBasis> {
  const effectiveAt = params.effectiveAt ?? new Date().toISOString();
  const account = await getCommercialTermsAccount(db, accountSource, params.accountId);
  assert(account, `Account ${params.accountId} is not available for commercial terms.`);
  assert(account.status === "active", `Account ${params.accountId} is not active.`);
  assert(isCommercialAccountType(account.account_type), `Account ${params.accountId} is missing account type.`);

  const [schedule, agreement] = await Promise.all([
    getActiveSchedule(db, effectiveAt),
    getActiveAgreement(db, params.accountId, effectiveAt),
  ]);

  assert(schedule || agreement, `No active commercial terms were found for account ${params.accountId}.`);

  return {
    accountId: params.accountId,
    accountType: account.account_type,
    scheduleId: schedule?.schedule_id ?? null,
    agreementId: agreement?.agreement_id ?? null,
    resolvedAt: effectiveAt,
    percentageBps:
      agreement?.marketplace_sales_fee_percentage_bps ?? schedule?.marketplace_sales_fee_percentage_bps ?? 0,
    fixedAmount:
      agreement?.marketplace_sales_fee_fixed_amount ?? schedule?.marketplace_sales_fee_fixed_amount ?? "0.00",
    capAmount: agreement ? null : (schedule?.marketplace_sales_fee_cap_amount ?? null),
    shippingAllowancePercentageBps:
      agreement?.shipping_allowance_percentage_bps ??
      schedule?.shipping_allowance_percentage_bps ??
      DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  };
}

function quoteFromListingTermsBasis(basis: ListingTermsBasis, rawAmount: string): ResolvedCommercialTerms {
  const amount = normalizeMoneyAmount(rawAmount, {
    fieldName: "Commercial terms amount",
    allowZero: true,
  });
  const marketplaceSalesFeeUnitAmount =
    basis.capAmount === null
      ? applyFeeFormula(amount, {
          percentageBps: basis.percentageBps,
          fixedAmount: basis.fixedAmount,
        })
      : quoteMarketplaceSalesFee(amount, {
          marketplaceSalesFeePercentageBps: basis.percentageBps,
          marketplaceSalesFeeFixedAmount: basis.fixedAmount,
          marketplaceSalesFeeCapAmount: basis.capAmount,
        });

  return {
    accountId: basis.accountId,
    accountType: basis.accountType,
    basisAmount: amount,
    marketplaceSalesFeeUnitAmount,
    sellerNetUnitAmount: subtractMoneyAmounts(amount, marketplaceSalesFeeUnitAmount),
    marketplaceSalesFeePercentageBps: basis.percentageBps,
    marketplaceSalesFeeFixedAmount: basis.fixedAmount,
    marketplaceSalesFeeCapAmount: basis.capAmount,
    shippingAllowancePercentageBps: basis.shippingAllowancePercentageBps,
    scheduleId: basis.scheduleId,
    agreementId: basis.agreementId,
    resolvedAt: basis.resolvedAt,
  };
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
  const basis = await resolveListingTermsBasis(db, accountSource, params);
  return quoteFromListingTermsBasis(basis, params.amount);
}

async function openListingTermsSession(
  db: PgQueryable,
  accountSource: CommercialTermsAccountSource | undefined,
  params: Readonly<{
    accountId: string;
    effectiveAt?: string;
  }>,
): Promise<ResolvedListingTermsSession> {
  const basis = await resolveListingTermsBasis(db, accountSource, params);

  return {
    accountId: basis.accountId,
    accountType: basis.accountType,
    scheduleId: basis.scheduleId,
    agreementId: basis.agreementId,
    resolvedAt: basis.resolvedAt,
    quote: (amount) => quoteFromListingTermsBasis(basis, amount),
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
  const schedule = await getActiveSchedule(db, effectiveAt);
  assert(schedule, "No active published marketplace sales fee schedule was found.");

  const marketplaceSalesFeeUnitAmount = quoteMarketplaceSalesFee(amount, {
    marketplaceSalesFeePercentageBps: schedule.marketplace_sales_fee_percentage_bps,
    marketplaceSalesFeeFixedAmount: schedule.marketplace_sales_fee_fixed_amount,
    marketplaceSalesFeeCapAmount: schedule.marketplace_sales_fee_cap_amount,
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

export type PublishedStandardScheduleTerms = Readonly<{
  accountType: CommercialAccountType;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  scheduleId: string | null;
  scheduleLabel: string | null;
  resolvedAt: string;
}>;

/**
 * The raw published standard-schedule fee terms (percentage + fixed, not a
 * quote against one basis amount) for an account type -- the offer-economics
 * monitor's foregone-fee-estimate input, which needs to apply the
 * percentage to an aggregate GMV figure and the fixed component per-trade
 * (`fixedAmount * tradeCount`), not `applyFeeFormula`'s single-basis-amount
 * shape that `resolvePublicStandardListingTerms` returns. Returns bps 0 /
 * "0.00" with null identifiers (never throws) when no schedule document is
 * active for the account type, so a monitor snapshot degrades to "no
 * standard schedule published yet" rather than failing outright.
 */
export async function resolveStandardScheduleTerms(
  db: PgQueryable,
  params: Readonly<{ accountType?: CommercialAccountType; effectiveAt?: string }>,
): Promise<PublishedStandardScheduleTerms> {
  const accountType = params.accountType ?? "personal";
  const effectiveAt = params.effectiveAt ?? new Date().toISOString();
  const schedule = await getActiveSchedule(db, effectiveAt);

  return {
    accountType,
    marketplaceSalesFeePercentageBps: schedule?.marketplace_sales_fee_percentage_bps ?? 0,
    marketplaceSalesFeeFixedAmount: schedule?.marketplace_sales_fee_fixed_amount ?? "0.00",
    scheduleId: schedule?.schedule_id ?? null,
    scheduleLabel: schedule?.label ?? null,
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
    openListingTermsSession: (params) => openListingTermsSession(deps.db, deps.accountSource, params),
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
      marketplaceSalesFeePercentageBps: 0,
      marketplaceSalesFeeFixedAmount: "0.00",
      marketplaceSalesFeeCapAmount: null,
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
    openListingTermsSession: async (params) => {
      const resolvedAt = params.effectiveAt ?? new Date().toISOString();

      return {
        accountId: params.accountId,
        accountType: "business" as const,
        scheduleId: null,
        agreementId: null,
        resolvedAt,
        quote: (amount) => {
          const normalized = normalizeMoneyAmount(amount, {
            fieldName: "Commercial terms amount",
            allowZero: true,
          });

          return {
            accountId: params.accountId,
            accountType: "business" as const,
            basisAmount: normalized,
            marketplaceSalesFeeUnitAmount: "0.00",
            sellerNetUnitAmount: normalized,
            marketplaceSalesFeePercentageBps: 0,
            marketplaceSalesFeeFixedAmount: "0.00",
            marketplaceSalesFeeCapAmount: null,
            shippingAllowancePercentageBps: DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
            scheduleId: null,
            agreementId: null,
            resolvedAt,
          };
        },
      };
    },
  };
}
