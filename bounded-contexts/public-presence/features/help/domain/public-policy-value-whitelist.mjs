/**
 * Public policy values are permissions, not a projection of policy documents.
 * Every entry names one reviewed public token and the exact field/derivation it
 * may read. Adding a policy definition or field never exposes it implicitly.
 */
export const publicPolicyValueWhitelist = [
  {
    key: "marketplace-sales-fee.standard.bps",
    policyKey: "commercial-terms.marketplace-sales-fee-schedule",
    type: "bps",
    selector: { path: ["marketplaceSalesFeePercentageBps"] },
  },
  {
    key: "marketplace-sales-fee.standard.fixed",
    policyKey: "commercial-terms.marketplace-sales-fee-schedule",
    type: "money",
    currency: "USD",
    selector: { path: ["marketplaceSalesFeeFixedAmount"] },
  },
  {
    key: "marketplace-sales-fee.standard.cap",
    policyKey: "commercial-terms.marketplace-sales-fee-schedule",
    type: "money",
    currency: "USD",
    selector: { path: ["marketplaceSalesFeeCapAmount"] },
  },
  {
    key: "marketplace-sales-fee.shipping-allowance.bps",
    policyKey: "commercial-terms.marketplace-sales-fee-schedule",
    type: "bps",
    selector: { path: ["shippingAllowancePercentageBps"] },
  },
  ...["card", "bank-account", "platform-credit"].flatMap((paymentMethodCategory) => [
    {
      key: `checkout-processing-fee.${paymentMethodCategory}.bps`,
      policyKey: "commercial-terms.checkout-processing-fee",
      type: "bps",
      selector: { checkoutMethod: paymentMethodCategory, component: "percentageBps" },
    },
    {
      key: `checkout-processing-fee.${paymentMethodCategory}.fixed`,
      policyKey: "commercial-terms.checkout-processing-fee",
      type: "money",
      currency: "USD",
      selector: { checkoutMethod: paymentMethodCategory, component: "fixedAmount" },
    },
  ]),
  {
    key: "settlement.clearance.base.days",
    policyKey: "settlement.clearance-window",
    type: "days",
    selector: { path: ["baseClearanceDays"] },
  },
  {
    key: "settlement.clearance.extended.days",
    policyKey: "settlement.clearance-window",
    type: "days",
    selector: { path: ["extendedClearanceDays"] },
  },
  {
    key: "settlement.clearance.high-value-threshold",
    policyKey: "settlement.clearance-window",
    type: "money",
    currency: "USD",
    selector: { path: ["highValueThresholdAmount"] },
  },
  {
    key: "settlement.payout.minimum",
    policyKey: "settlement.payout-bounds",
    type: "money",
    currency: "USD",
    selector: { path: ["minimumAmount"] },
  },
  {
    key: "settlement.payout.maximum",
    policyKey: "settlement.payout-bounds",
    type: "money",
    currency: "USD",
    selector: { path: ["maximumAmount"] },
  },
  {
    key: "rate-limits.waitlist.maximum-requests",
    policyKey: "platform-operations.rate-limits",
    type: "number",
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
    selector: {
      rateLimitSurface: "public-presence.waitlist.submit",
      component: "windowMs",
      defaults: { max: 20, windowMs: 600000 },
    },
  },
];

export const publicPolicyValueKeys = new Set(publicPolicyValueWhitelist.map(({ key }) => key));
