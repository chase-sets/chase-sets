import {
  centsToMoneyAmount,
  moneyToCents,
  type MoneyAmount,
} from "@chase-sets/primitives/money";
import { requireBasisPoints, requirePositiveInteger, type Money } from "./contracts";

export type SellerOverheadTerms = Readonly<{
  platformFeeRelativeBps: number;
  platformFeeFixedPerUnitAmount: Money;
  platformFeeCapPerUnitAmount: Money | null;
  sellerHandlingRelativeBps: number;
  sellerHandlingFixedPerUnitAmount: Money;
  sellerHandlingCapPerUnitAmount: Money | null;
}>;

export type SellerOverheadQuote = Readonly<{
  platformFeePerUnitAmount: Money;
  sellerHandlingPerUnitAmount: Money;
  unitOverheadAmount: Money;
  orderOverheadAmount: Money;
  grossProceedsAmount: Money;
  netProceedsAmount: Money;
}>;

export function quoteSellerOverhead(
  marketUnitPrice: Money,
  quantity: number,
  terms: SellerOverheadTerms,
): SellerOverheadQuote {
  const units = requirePositiveInteger(quantity, "quantity", Number.MAX_SAFE_INTEGER);
  const currency = marketUnitPrice.currency;
  const unitPriceCents = moneyToCents(marketUnitPrice.amount);
  const platformFeeCents = cappedRelativePlusFixed(
    unitPriceCents,
    requireBasisPoints(terms.platformFeeRelativeBps, "platformFeeRelativeBps"),
    checkedMoneyCents(terms.platformFeeFixedPerUnitAmount, currency, "platformFeeFixedPerUnitAmount"),
    checkedOptionalMoneyCents(terms.platformFeeCapPerUnitAmount, currency, "platformFeeCapPerUnitAmount"),
  );
  const handlingCents = cappedRelativePlusFixed(
    unitPriceCents,
    requireBasisPoints(terms.sellerHandlingRelativeBps, "sellerHandlingRelativeBps"),
    checkedMoneyCents(terms.sellerHandlingFixedPerUnitAmount, currency, "sellerHandlingFixedPerUnitAmount"),
    checkedOptionalMoneyCents(terms.sellerHandlingCapPerUnitAmount, currency, "sellerHandlingCapPerUnitAmount"),
  );
  const unitOverheadCents = platformFeeCents + handlingCents;
  const orderOverheadCents = unitOverheadCents * BigInt(units);
  const grossCents = unitPriceCents * BigInt(units);
  const netCents = grossCents > orderOverheadCents ? grossCents - orderOverheadCents : 0n;

  return {
    platformFeePerUnitAmount: money(platformFeeCents, currency),
    sellerHandlingPerUnitAmount: money(handlingCents, currency),
    unitOverheadAmount: money(unitOverheadCents, currency),
    orderOverheadAmount: money(orderOverheadCents, currency),
    grossProceedsAmount: money(grossCents, currency),
    netProceedsAmount: money(netCents, currency),
  };
}

function cappedRelativePlusFixed(
  unitPriceCents: bigint,
  relativeBps: number,
  fixedCents: bigint,
  relativeCapCents: bigint | null,
): bigint {
  const relativeCents = divideCeil(unitPriceCents * BigInt(relativeBps), 10_000n);
  return (relativeCapCents === null || relativeCents < relativeCapCents ? relativeCents : relativeCapCents) + fixedCents;
}

function divideCeil(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function checkedMoneyCents(value: Money, currency: string, fieldName: string): bigint {
  if (value.currency !== currency) throw new Error(`${fieldName} currency must match ${currency}.`);
  return moneyToCents(value.amount);
}

function checkedOptionalMoneyCents(value: Money | null, currency: string, fieldName: string): bigint | null {
  return value === null ? null : checkedMoneyCents(value, currency, fieldName);
}

function money(cents: bigint, currency: string): Money {
  return { amount: centsToMoneyAmount(cents) as MoneyAmount, currency };
}

