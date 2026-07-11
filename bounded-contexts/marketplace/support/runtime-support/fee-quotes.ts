import type { CommercialTermsResolver } from "../../api";
import type {
  MarketplaceListingTermsPreview,
  MarketplacePublicStandardTermsPreview,
} from "../../features/listings/ui/contracts";

export const PUBLIC_STANDARD_SELLER_ACCOUNT_TYPE = "personal" as const;

export function createFeeQuoteFingerprint(
  quote: Readonly<{
    basis_amount: string;
    marketplace_sales_fee_unit_amount: string;
    seller_net_unit_amount: string;
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
    shipping_allowance_percentage_bps: terms.shippingAllowancePercentageBps,
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
        shipping_allowance_percentage_bps: terms.shippingAllowancePercentageBps,
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
