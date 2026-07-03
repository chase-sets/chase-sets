import {
  applyBasisPointsToMoneyAmount,
  centsToMoneyAmount,
  moneyToCents,
  sumMoneyAmounts,
  tryMoneyToCents,
} from "@chase-sets/primitives/money";

export type TaxDestinationAddress = Readonly<{
  name: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}>;

export type TaxQuoteInput = Readonly<{
  buyerAccountId: string;
  sellerAccountId: string;
  currencyCode: "usd";
  destinationAddress: TaxDestinationAddress;
  itemSubtotalAmount: string;
  shippingAmount: string;
  marketplaceCheckoutFeeAmount?: string | null;
}>;

export type TaxQuote = Readonly<{
  taxableAmount: string;
  taxAmount: string;
  jurisdictionCountry: string;
  jurisdictionState: string | null;
  rateBps: number;
  itemTaxable: boolean;
  shippingTaxable: boolean;
  marketplaceCheckoutFeeTaxable: boolean;
  providerName: string;
  providerQuoteReference: string | null;
  quotedAt: string;
}>;

export interface TaxQuoteResolver {
  quoteTax(input: TaxQuoteInput): Promise<TaxQuote>;
}

export type LocalTaxRule = Readonly<{
  country: string;
  state?: string | null;
  rateBps: number;
  itemTaxable?: boolean;
  shippingTaxable?: boolean;
  marketplaceCheckoutFeeTaxable?: boolean;
}>;

function normalizeMoneyAmount(value: string | null | undefined) {
  const normalized = String(value ?? "0.00").trim();
  const cents = tryMoneyToCents(normalized);
  if (cents === null) {
    throw new Error("Tax amounts must be non-negative money values.");
  }

  return centsToMoneyAmount(cents);
}

function normalizeJurisdiction(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function chooseRule(rules: readonly LocalTaxRule[], address: TaxDestinationAddress) {
  const country = normalizeJurisdiction(address.country);
  const state = normalizeJurisdiction(address.state);
  return (
    rules.find(
      (rule) => normalizeJurisdiction(rule.country) === country && normalizeJurisdiction(rule.state) === state,
    ) ??
    rules.find((rule) => normalizeJurisdiction(rule.country) === country && !normalizeJurisdiction(rule.state)) ??
    null
  );
}

export function createLocalTaxQuoteResolver(rules: readonly LocalTaxRule[] = []): TaxQuoteResolver {
  return {
    async quoteTax(input) {
      const rule = chooseRule(rules, input.destinationAddress);
      const itemSubtotalAmount = normalizeMoneyAmount(input.itemSubtotalAmount);
      const shippingAmount = normalizeMoneyAmount(input.shippingAmount);
      const marketplaceCheckoutFeeAmount = normalizeMoneyAmount(input.marketplaceCheckoutFeeAmount);
      const itemTaxable = rule?.itemTaxable ?? Boolean(rule);
      const shippingTaxable = rule?.shippingTaxable ?? false;
      const marketplaceCheckoutFeeTaxable = rule?.marketplaceCheckoutFeeTaxable ?? false;
      const taxableAmount = sumMoneyAmounts([
        itemTaxable ? itemSubtotalAmount : "0.00",
        shippingTaxable ? shippingAmount : "0.00",
        marketplaceCheckoutFeeTaxable ? marketplaceCheckoutFeeAmount : "0.00",
      ]);
      const rateBps = rule?.rateBps ?? 0;

      return {
        taxableAmount,
        taxAmount:
          moneyToCents(taxableAmount) > 0n ? applyBasisPointsToMoneyAmount(taxableAmount, rateBps, "ceil") : "0.00",
        jurisdictionCountry: normalizeJurisdiction(input.destinationAddress.country),
        jurisdictionState: normalizeJurisdiction(input.destinationAddress.state) || null,
        rateBps,
        itemTaxable,
        shippingTaxable,
        marketplaceCheckoutFeeTaxable,
        providerName: "local-stub",
        providerQuoteReference: null,
        quotedAt: new Date().toISOString(),
      };
    },
  };
}

export const zeroTaxQuoteResolver = createLocalTaxQuoteResolver();
