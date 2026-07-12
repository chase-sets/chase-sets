import { quoteLockedMarketplaceFeeTerms, type CommercialTermsResolver } from "../../api";
import type { MarketplaceListingFeeLock } from "../../features/listings/domain/fee-lock";
import type {
  MarketplaceListingTermsPreview,
  MarketplacePublicStandardTermsPreview,
} from "../../features/listings/ui/contracts";

export const PUBLIC_STANDARD_SELLER_ACCOUNT_TYPE = "personal" as const;

function resolvedFormulaFields(
  terms: Readonly<{
    basisAmount: string;
    marketplaceSalesFeeUnitAmount: string;
    marketplaceSalesFeePercentageBps?: number;
    marketplaceSalesFeeFixedAmount?: string;
    marketplaceSalesFeeCapAmount?: string | null;
  }>,
) {
  const inferredPercentageBps =
    Number(terms.basisAmount) > 0
      ? Math.round((Number(terms.marketplaceSalesFeeUnitAmount) / Number(terms.basisAmount)) * 10_000)
      : 0;
  return {
    marketplace_sales_fee_percentage_bps: terms.marketplaceSalesFeePercentageBps ?? inferredPercentageBps,
    marketplace_sales_fee_fixed_amount: terms.marketplaceSalesFeeFixedAmount ?? "0.00",
    marketplace_sales_fee_cap_amount: terms.marketplaceSalesFeeCapAmount ?? null,
  };
}

export function createFeeQuoteFingerprint(
  quote: Readonly<{
    basis_amount: string;
    marketplace_sales_fee_unit_amount: string;
    seller_net_unit_amount: string;
    marketplace_sales_fee_percentage_bps?: number;
    marketplace_sales_fee_fixed_amount?: string;
    marketplace_sales_fee_cap_amount?: string | null;
    shipping_allowance_percentage_bps: number;
    schedule_id: string | null;
    agreement_id: string | null;
  }>,
) {
  return [
    quote.basis_amount,
    quote.marketplace_sales_fee_unit_amount,
    quote.seller_net_unit_amount,
    String(quote.shipping_allowance_percentage_bps),
    quote.schedule_id ?? "",
    quote.agreement_id ?? "",
  ].join("|");
}

export async function quoteMarketplaceTerms(
  resolver: CommercialTermsResolver,
  params: Readonly<{ accountId: string; priceAmount: string }>,
): Promise<MarketplaceListingTermsPreview> {
  const terms = await resolver.resolveListingTerms({
    accountId: params.accountId,
    amount: params.priceAmount,
  });
  const quote = {
    account_type: terms.accountType,
    basis_amount: terms.basisAmount,
    marketplace_sales_fee_unit_amount: terms.marketplaceSalesFeeUnitAmount,
    seller_net_unit_amount: terms.sellerNetUnitAmount,
    ...resolvedFormulaFields(terms),
    shipping_allowance_percentage_bps: terms.shippingAllowancePercentageBps ?? 500,
    schedule_id: terms.scheduleId,
    agreement_id: terms.agreementId,
    resolved_at: terms.resolvedAt,
    fee_quote_fingerprint: "",
  };

  return {
    ...quote,
    fee_quote_fingerprint: createFeeQuoteFingerprint(quote),
  };
}

/**
 * A per-account marketplace listing-terms session, part of the m113
 * repricing-at-scale throughput lane: wraps
 * `CommercialTermsResolver.openListingTermsSession` so a bulk
 * caller resolves the account's active schedule/agreement ONCE, then calls
 * `quote(priceAmount)` locally (pure, synchronous, no DB / no HTTP) for
 * every listing in the batch. `quote` builds its result through the exact
 * same field mapping and `createFeeQuoteFingerprint` call as
 * `quoteMarketplaceTerms`, so a session quote is byte-identical to what
 * `previewListingTerms` would have returned for that price.
 */
export type MarketplaceListingTermsSession = Readonly<{
  accountId: string;
  scheduleId: string | null;
  agreementId: string | null;
  resolvedAt: string;
  quote: (priceAmount: string) => MarketplaceListingTermsPreview;
}>;

export async function openMarketplaceListingTermsSession(
  resolver: CommercialTermsResolver,
  params: Readonly<{ accountId: string; effectiveAt?: string }>,
): Promise<MarketplaceListingTermsSession> {
  const session = await resolver.openListingTermsSession(params);

  return {
    accountId: session.accountId,
    scheduleId: session.scheduleId,
    agreementId: session.agreementId,
    resolvedAt: session.resolvedAt,
    quote: (priceAmount) => {
      const terms = session.quote(priceAmount);
      const quote = {
        account_type: terms.accountType,
        basis_amount: terms.basisAmount,
        marketplace_sales_fee_unit_amount: terms.marketplaceSalesFeeUnitAmount,
        seller_net_unit_amount: terms.sellerNetUnitAmount,
        ...resolvedFormulaFields(terms),
        shipping_allowance_percentage_bps: terms.shippingAllowancePercentageBps ?? 500,
        schedule_id: terms.scheduleId,
        agreement_id: terms.agreementId,
        resolved_at: terms.resolvedAt,
        fee_quote_fingerprint: "",
      };

      return {
        ...quote,
        fee_quote_fingerprint: createFeeQuoteFingerprint(quote),
      };
    },
  };
}

export function feeLockFromMarketplaceTermsQuote(
  unitCount: number,
  quote: MarketplaceListingTermsPreview,
): MarketplaceListingFeeLock {
  return {
    unitCount,
    terms: {
      marketplaceSalesFeePercentageBps: quote.marketplace_sales_fee_percentage_bps,
      marketplaceSalesFeeFixedAmount: quote.marketplace_sales_fee_fixed_amount,
      marketplaceSalesFeeCapAmount: quote.marketplace_sales_fee_cap_amount,
      shippingAllowancePercentageBps: quote.shipping_allowance_percentage_bps,
      termsScheduleId: quote.schedule_id,
      termsAgreementId: quote.agreement_id,
      termsResolvedAt: quote.resolved_at,
    },
    marketplaceSalesFeeUnitAmount: quote.marketplace_sales_fee_unit_amount,
    sellerNetUnitAmount: quote.seller_net_unit_amount,
    feeQuoteFingerprint: quote.fee_quote_fingerprint,
  };
}

export function requoteMarketplaceListingFeeLock(
  feeLock: MarketplaceListingFeeLock,
  priceAmount: string,
): MarketplaceListingFeeLock {
  const quote = quoteLockedMarketplaceFeeTerms(feeLock.terms, priceAmount);
  const fingerprintInput = {
    basis_amount: quote.basisAmount,
    marketplace_sales_fee_unit_amount: quote.marketplaceSalesFeeUnitAmount,
    seller_net_unit_amount: quote.sellerNetUnitAmount,
    marketplace_sales_fee_percentage_bps: feeLock.terms.marketplaceSalesFeePercentageBps,
    marketplace_sales_fee_fixed_amount: feeLock.terms.marketplaceSalesFeeFixedAmount,
    marketplace_sales_fee_cap_amount: feeLock.terms.marketplaceSalesFeeCapAmount,
    shipping_allowance_percentage_bps: feeLock.terms.shippingAllowancePercentageBps,
    schedule_id: feeLock.terms.termsScheduleId,
    agreement_id: feeLock.terms.termsAgreementId,
  };
  return {
    ...feeLock,
    marketplaceSalesFeeUnitAmount: quote.marketplaceSalesFeeUnitAmount,
    sellerNetUnitAmount: quote.sellerNetUnitAmount,
    feeQuoteFingerprint: createFeeQuoteFingerprint(fingerprintInput),
  };
}

export async function quotePublicStandardMarketplaceTerms(
  resolver: CommercialTermsResolver,
  params: Readonly<{ priceAmount: string }>,
): Promise<MarketplacePublicStandardTermsPreview> {
  const terms = await resolver.resolvePublicStandardListingTerms({
    accountType: PUBLIC_STANDARD_SELLER_ACCOUNT_TYPE,
    amount: params.priceAmount,
  });

  return {
    account_type: terms.accountType,
    basis_amount: terms.basisAmount,
    marketplace_sales_fee_unit_amount: terms.marketplaceSalesFeeUnitAmount,
    seller_net_unit_amount: terms.sellerNetUnitAmount,
    shipping_allowance_percentage_bps: terms.shippingAllowancePercentageBps,
    source_kind: "public-standard-seller-terms",
    source_label: "Standard seller terms",
    schedule_label: terms.scheduleLabel,
    source_updated_at: terms.scheduleUpdatedAt,
    resolved_at: terms.resolvedAt,
  };
}
