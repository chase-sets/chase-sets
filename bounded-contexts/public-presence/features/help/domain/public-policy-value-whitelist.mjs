/**
 * Public policy values are permissions, not a projection of policy documents.
 * Every entry names one reviewed public token and the exact field/derivation it
 * may read. Adding a policy definition or field never exposes it implicitly.
 */
const basisPointsContract = { primitive: "integer", minimum: 0, maximum: 10_000 };
const nonNegativeMoneyContract = { primitive: "money", minimumCents: 0 };
const positiveMoneyContract = { primitive: "money", minimumCents: 1 };
const clearanceDaysContract = { primitive: "integer", minimum: 0, maximum: 30 };
const supportDeadlineHoursContract = { primitive: "integer", minimum: 4, maximum: 336 };

export const publicPolicyValueWhitelist = [
  {
    key: "marketplace-sales-fee.standard.bps",
    policyKey: "commercial-terms.marketplace-sales-fee-schedule",
    type: "bps",
    valueContract: basisPointsContract,
    selector: { path: ["marketplaceSalesFeePercentageBps"] },
  },
  {
    key: "marketplace-sales-fee.standard.fixed",
    policyKey: "commercial-terms.marketplace-sales-fee-schedule",
    type: "money",
    currency: "USD",
    valueContract: nonNegativeMoneyContract,
    selector: { path: ["marketplaceSalesFeeFixedAmount"] },
  },
  {
    key: "marketplace-sales-fee.standard.cap",
    policyKey: "commercial-terms.marketplace-sales-fee-schedule",
    type: "money",
    currency: "USD",
    valueContract: positiveMoneyContract,
    selector: { path: ["marketplaceSalesFeeCapAmount"] },
  },
  {
    key: "marketplace-sales-fee.shipping-allowance.bps",
    policyKey: "commercial-terms.marketplace-sales-fee-schedule",
    type: "bps",
    valueContract: basisPointsContract,
    selector: { path: ["shippingAllowancePercentageBps"] },
  },
  ...["card", "bank-account", "platform-credit"].flatMap((paymentMethodCategory) => [
    {
      key: `checkout-processing-fee.${paymentMethodCategory}.bps`,
      policyKey: "commercial-terms.checkout-processing-fee",
      type: "bps",
      valueContract: basisPointsContract,
      selector: { checkoutMethod: paymentMethodCategory, component: "percentageBps" },
    },
    {
      key: `checkout-processing-fee.${paymentMethodCategory}.fixed`,
      policyKey: "commercial-terms.checkout-processing-fee",
      type: "money",
      currency: "USD",
      valueContract: nonNegativeMoneyContract,
      selector: { checkoutMethod: paymentMethodCategory, component: "fixedAmount" },
    },
  ]),
  {
    key: "settlement.clearance.base.days",
    policyKey: "settlement.clearance-window",
    type: "days",
    valueContract: clearanceDaysContract,
    selector: { path: ["baseClearanceDays"] },
  },
  {
    key: "settlement.clearance.extended.days",
    policyKey: "settlement.clearance-window",
    type: "days",
    valueContract: clearanceDaysContract,
    selector: { path: ["extendedClearanceDays"] },
  },
  {
    key: "settlement.clearance.high-value-threshold",
    policyKey: "settlement.clearance-window",
    type: "money",
    currency: "USD",
    valueContract: nonNegativeMoneyContract,
    selector: { path: ["highValueThresholdAmount"] },
  },
  {
    key: "settlement.payout.minimum",
    policyKey: "settlement.payout-bounds",
    type: "money",
    currency: "USD",
    valueContract: nonNegativeMoneyContract,
    selector: { path: ["minimumAmount"] },
  },
  {
    key: "settlement.payout.maximum",
    policyKey: "settlement.payout-bounds",
    type: "money",
    currency: "USD",
    valueContract: positiveMoneyContract,
    selector: { path: ["maximumAmount"] },
  },
  {
    key: "support-deadlines.product-not-received.seller-response.hours",
    policyKey: "platform-operations.support-deadlines",
    type: "hours",
    valueContract: supportDeadlineHoursContract,
    selector: { path: ["product-not-received", "sellerResponseHours"] },
  },
  {
    key: "support-deadlines.product-not-received.support-review.hours",
    policyKey: "platform-operations.support-deadlines",
    type: "hours",
    valueContract: supportDeadlineHoursContract,
    selector: { path: ["product-not-received", "supportReviewHours"] },
  },
  {
    key: "support-deadlines.item-problem.post-delivery-open.days",
    policyKey: "platform-operations.support-deadlines",
    type: "days",
    valueContract: { primitive: "integer", minimum: 30, maximum: 30 },
    selector: { path: ["product-not-received", "postDeliveryOpenWindowDays"] },
  },
  ...["product-not-as-described", "product-damaged", "wrong-product-received", "missing-products"].map((flowType) => ({
    key: `support-deadlines.${flowType}.seller-response.hours`,
    policyKey: "platform-operations.support-deadlines",
    type: "hours",
    valueContract: supportDeadlineHoursContract,
    selector: { path: [flowType, "sellerResponseHours"] },
  })),
  {
    key: "support-deadlines.return-request.seller-response.hours",
    policyKey: "platform-operations.support-deadlines",
    type: "hours",
    valueContract: supportDeadlineHoursContract,
    selector: { path: ["return-request", "sellerResponseHours"] },
  },
  {
    key: "support-deadlines.buyer-cancel-request.seller-response.hours",
    policyKey: "platform-operations.support-deadlines",
    type: "hours",
    valueContract: supportDeadlineHoursContract,
    selector: { path: ["buyer-cancel-request", "sellerResponseHours"] },
  },
  {
    key: "rate-limits.waitlist.maximum-requests",
    policyKey: "platform-operations.rate-limits",
    type: "number",
    // The owning override allows 1,000,000 and the owning incident
    // multiplier may be as low as 0.1, so the rendered effective max is 10x.
    valueContract: { primitive: "integer", minimum: 1, maximum: 10_000_000 },
    selector: {
      rateLimitSurface: "public-presence.waitlist.submit",
      component: "max",
      defaults: { max: 20, windowMs: 600000 },
    },
  },
  {
    key: "rate-limits.waitlist.window",
    policyKey: "platform-operations.rate-limits",
    type: "minutes",
    valueContract: { primitive: "integer", minimum: 1_000, maximum: 86_400_000 },
    selector: {
      rateLimitSurface: "public-presence.waitlist.submit",
      component: "windowMs",
      defaults: { max: 20, windowMs: 600000 },
    },
  },
];

export const publicPolicyValueKeys = new Set(publicPolicyValueWhitelist.map(({ key }) => key));
