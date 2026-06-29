const paymentMethodCategories = ["card", "bank-account", "platform-credit"] as const;

type CheckoutPaymentMethodCategory = (typeof paymentMethodCategories)[number];

export type CheckoutPaymentPreviewStatus = Readonly<{
  order_ids: readonly string[];
  currency_code: string;
  amount: string;
  marketplace_checkout_fee: CheckoutMarketplaceFeeQuote;
  payment_method_quotes: readonly CheckoutMarketplaceFeeQuote[];
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

export type CheckoutMarketplaceFeeQuote = Readonly<{
  payment_method_category: CheckoutPaymentMethodCategory;
  external_basis_amount: string;
  marketplace_checkout_fee_amount: string;
  marketplace_checkout_fee_reduction_amount: string;
  total_amount: string;
  processor_amount: string;
  policy_version: string;
  quote_fingerprint: string;
  quoted_at: string;
}>;

function moneyCents(value: string | null | undefined) {
  const text = String(value ?? "0.00").trim();
  const match = /^(-?\d+)(?:\.(\d{0,2}))?$/.exec(text);
  if (!match) {
    return 0n;
  }

  const dollars = BigInt(match[1] ?? "0") * 100n;
  const cents = BigInt((match[2] ?? "").padEnd(2, "0"));
  return dollars >= 0 ? dollars + cents : dollars - cents;
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

function normalizePaymentMethodCategory(value: string | null | undefined): CheckoutPaymentMethodCategory {
  switch ((value ?? "card").trim()) {
    case "bank-account":
    case "bank_account":
    case "bank":
      return "bank-account";
    case "platform-credit":
    case "platform_credit":
    case "credit":
      return "platform-credit";
    default:
      return "card";
  }
}

function ceilMoneyAmount(value: number) {
  if (value <= 0) {
    return "0.00";
  }

  return (Math.ceil((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

function quoteMarketplaceCheckoutFee(
  params: Readonly<{
    orderAmount: string;
    externalBasisAmount: string;
    balanceCreditAmount: string;
    paymentMethodCategory: CheckoutPaymentMethodCategory;
    quotedAt?: string;
  }>,
): CheckoutMarketplaceFeeQuote {
  const policyVersion = "marketplace-checkout-fee-v1";
  const externalBasisAmount = normalizeMoney(params.externalBasisAmount);
  const externalBasis = Number.parseFloat(externalBasisAmount);
  const method = externalBasis === 0 ? "platform-credit" : params.paymentMethodCategory;
  const rateBps = method === "platform-credit" ? 0 : method === "bank-account" ? 50 : 290;
  const fixedAmount = method === "card" ? 0.3 : 0;
  const rate = rateBps / 10_000;
  const feeAmount =
    rate > 0 || fixedAmount > 0 ? ceilMoneyAmount((externalBasis * rate + fixedAmount) / (1 - rate)) : "0.00";
  const cardFeeAmount = externalBasis > 0 ? ceilMoneyAmount((externalBasis * 0.029 + 0.3) / (1 - 0.029)) : "0.00";
  const reductionAmount = ceilMoneyAmount(Number.parseFloat(cardFeeAmount) - Number.parseFloat(feeAmount));
  const orderAmount = normalizeMoney(params.orderAmount);
  const balanceCreditAmount = normalizeMoney(params.balanceCreditAmount);
  const totalAmount = addMoney(orderAmount, feeAmount);
  const processorAmount = addMoney(externalBasisAmount, feeAmount);
  const quotedAt = params.quotedAt ?? new Date().toISOString();
  const quoteFingerprint = [
    policyVersion,
    method,
    orderAmount,
    balanceCreditAmount,
    externalBasisAmount,
    feeAmount,
    totalAmount,
    processorAmount,
  ].join("|");

  return {
    payment_method_category: method,
    external_basis_amount: externalBasisAmount,
    marketplace_checkout_fee_amount: feeAmount,
    marketplace_checkout_fee_reduction_amount: reductionAmount,
    total_amount: totalAmount,
    processor_amount: processorAmount,
    policy_version: policyVersion,
    quote_fingerprint: quoteFingerprint,
    quoted_at: quotedAt,
  };
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
  const paymentMethodCategory = normalizePaymentMethodCategory(params.paymentMethodCategory);
  const paymentMethodQuotes = paymentMethodCategories.map((method) =>
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
