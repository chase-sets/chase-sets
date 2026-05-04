import type { CommercialTermsResolver } from "../../api";
import type { MarketplaceListingTermsPreview } from "../../features/listings/ui/contracts";

export function createFeeQuoteFingerprint(quote: Readonly<{
  basis_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  schedule_id: string | null;
  agreement_id: string | null;
}>) {
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
