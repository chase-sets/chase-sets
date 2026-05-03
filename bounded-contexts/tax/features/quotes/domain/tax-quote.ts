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
  const amount = Number.parseFloat(String(value ?? "0.00"));
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Tax amounts must be non-negative money values.");
  }
  return amount.toFixed(2);
}

function ceilMoney(value: number) {
  if (value <= 0) {
    return "0.00";
  }
  return (Math.ceil((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

function normalizeJurisdiction(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function chooseRule(
  rules: readonly LocalTaxRule[],
  address: TaxDestinationAddress,
) {
  const country = normalizeJurisdiction(address.country);
  const state = normalizeJurisdiction(address.state);
  return (
    rules.find(
      (rule) =>
        normalizeJurisdiction(rule.country) === country &&
        normalizeJurisdiction(rule.state) === state,
    ) ??
    rules.find(
      (rule) =>
        normalizeJurisdiction(rule.country) === country &&
        !normalizeJurisdiction(rule.state),
    ) ??
    null
  );
}

export function createLocalTaxQuoteResolver(
  rules: readonly LocalTaxRule[] = [],
): TaxQuoteResolver {
  return {
    async quoteTax(input) {
      const rule = chooseRule(rules, input.destinationAddress);
      const itemSubtotalAmount = Number.parseFloat(
        normalizeMoneyAmount(input.itemSubtotalAmount),
      );
      const shippingAmount = Number.parseFloat(
        normalizeMoneyAmount(input.shippingAmount),
      );
      const marketplaceCheckoutFeeAmount = Number.parseFloat(
        normalizeMoneyAmount(input.marketplaceCheckoutFeeAmount),
      );
      const itemTaxable = rule?.itemTaxable ?? Boolean(rule);
      const shippingTaxable = rule?.shippingTaxable ?? false;
      const marketplaceCheckoutFeeTaxable =
        rule?.marketplaceCheckoutFeeTaxable ?? false;
      const taxableAmount =
        (itemTaxable ? itemSubtotalAmount : 0) +
        (shippingTaxable ? shippingAmount : 0) +
        (marketplaceCheckoutFeeTaxable ? marketplaceCheckoutFeeAmount : 0);
      const rateBps = rule?.rateBps ?? 0;

      return {
        taxableAmount: taxableAmount.toFixed(2),
        taxAmount: ceilMoney((taxableAmount * rateBps) / 10_000),
        jurisdictionCountry: normalizeJurisdiction(input.destinationAddress.country),
        jurisdictionState:
          normalizeJurisdiction(input.destinationAddress.state) || null,
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
