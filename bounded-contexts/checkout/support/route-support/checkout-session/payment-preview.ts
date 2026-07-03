import {
  marketplaceCheckoutFeePaymentMethodCategories,
  normalizeMarketplaceCheckoutFeePaymentMethodCategory,
  quoteMarketplaceCheckoutFee,
  type MarketplaceCheckoutFeeQuote,
} from "@chase-sets/payments/server";

export type CheckoutPaymentPreviewStatus = Readonly<{
  order_ids: readonly string[];
  currency_code: string;
  amount: string;
  marketplace_checkout_fee: MarketplaceCheckoutFeeQuote;
  payment_method_quotes: readonly MarketplaceCheckoutFeeQuote[];
  wallet_credit: Readonly<{
    requested_amount: string;
    applied_amount: string;
    external_amount: string;
  }>;
  can_start_payment: boolean;
  unavailable_reasons: readonly string[];
  unavailable_reason_details: readonly Readonly<{
    code: string;
    message: string;
  }>[];
}>;

function moneyCents(value: string | null | undefined) {
  const text = String(value ?? "0.00").trim();
  const match = /^(-?\d+)(?:\.(\d{0,2}))?$/.exec(text);
  if (!match) {
    throw new Error("Checkout money amount must be a valid decimal.");
  }

  const negative = text.startsWith("-");
  const dollars = BigInt(match[1] ?? "0") * 100n;
  const cents = BigInt((match[2] ?? "").padEnd(2, "0"));
  return negative ? dollars - cents : dollars + cents;
}

function formatMoney(cents: bigint) {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function normalizeMoney(value: string | null | undefined) {
  return formatMoney(moneyCents(value));
}

function addMoney(left: string, right: string) {
  return formatMoney(moneyCents(left) + moneyCents(right));
}

function subtractMoney(left: string, right: string) {
  return formatMoney(moneyCents(left) - moneyCents(right));
}

function minMoney(left: string, right: string) {
  return moneyCents(left) <= moneyCents(right) ? left : right;
}

function compareMoney(left: string, right: string) {
  const leftCents = moneyCents(left);
  const rightCents = moneyCents(right);
  return leftCents === rightCents ? 0 : leftCents < rightCents ? -1 : 1;
}

export function buildCheckoutPaymentPreviewStatus(
  params: Readonly<{
    orderIds?: readonly string[];
    amount: string;
    currencyCode?: string | null;
    requestedBalanceCreditAmount?: string | null;
    paymentMethodCategory?: string | null;
    quotedAt?: string;
  }>,
): CheckoutPaymentPreviewStatus {
  const amount = normalizeMoney(params.amount);
  const requestedBalanceCreditAmount = normalizeMoney(params.requestedBalanceCreditAmount);
  const appliedAmount =
    compareMoney(requestedBalanceCreditAmount, "0.00") > 0 ? minMoney(requestedBalanceCreditAmount, amount) : "0.00";
  const externalAmount = subtractMoney(amount, appliedAmount);
  const paymentMethodCategory = normalizeMarketplaceCheckoutFeePaymentMethodCategory(params.paymentMethodCategory);
  const paymentMethodQuotes = marketplaceCheckoutFeePaymentMethodCategories.map((method) =>
    quoteMarketplaceCheckoutFee({
      orderAmount: amount,
      externalBasisAmount: externalAmount,
      balanceCreditAmount: appliedAmount,
      paymentMethodCategory: method,
      quotedAt: params.quotedAt,
    }),
  );
  const marketplaceCheckoutFee =
    paymentMethodQuotes.find((quote) => quote.payment_method_category === paymentMethodCategory) ??
    paymentMethodQuotes[0]!;
  const canStartPayment = compareMoney(amount, "0.00") > 0;

  return {
    order_ids: params.orderIds ?? [],
    currency_code:
      String(params.currencyCode ?? "usd")
        .trim()
        .toLowerCase() || "usd",
    amount,
    marketplace_checkout_fee: marketplaceCheckoutFee,
    payment_method_quotes: paymentMethodQuotes,
    wallet_credit: {
      requested_amount: requestedBalanceCreditAmount,
      applied_amount: appliedAmount,
      external_amount: externalAmount,
    },
    can_start_payment: canStartPayment,
    unavailable_reasons: canStartPayment ? [] : ["no-payable-order-balance"],
    unavailable_reason_details: canStartPayment
      ? []
      : [
          {
            code: "no-payable-order-balance",
            message: "No payable order balance is available.",
          },
        ],
  };
}
