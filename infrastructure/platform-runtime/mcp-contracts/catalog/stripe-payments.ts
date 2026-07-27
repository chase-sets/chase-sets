import {
  type McpServiceDescriptor,
  emptySchema,
  objectSchema,
  readTool,
  resource,
  stringProperty,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

export const stripePaymentsService = {
  serviceId: "stripe-payments",
  serviceName: "Stripe Payments",
  kind: "external-provider",
  owner: "infrastructure/stripe-payments",
  packageName: "@chase-sets/stripe-payments",
  serviceBoundary:
    "Provider adapter for payment sessions, refunds, and Stripe payment webhooks. Agents should prefer Payments tools except for support-safe provider diagnostics.",
  tools: [
    readTool(
      "stripe-payments",
      "get-public-config",
      "Get Stripe Public Config",
      "Read publishable, non-secret payment processor configuration.",
      "orders.view",
      emptySchema,
      "processor-config",
      ["Use to explain payment confirmation capabilities without exposing secrets."],
      "operator",
    ),
    readTool(
      "stripe-payments",
      "inspect-payment-reference",
      "Inspect Stripe Payment Reference",
      "Inspect support-safe Stripe status for a known internal payment reference.",
      "orders.view",
      objectSchema(
        {
          paymentId: stringProperty("Internal payment identifier."),
          processorPaymentReference: stringProperty("Stripe payment reference."),
        },
        ["paymentId", "processorPaymentReference"],
      ),
      "processor-payment",
      ["Use for support diagnostics after checking the Payments read model."],
      "operator",
    ),
  ],
  resources: [
    resource(
      "stripe-payments",
      "chase-sets://providers/stripe-payments/payments/{paymentId}",
      "Stripe Payment Diagnostic",
      "Support-safe provider payment diagnostic view.",
      "orders.view",
      ["Use only for diagnostics; writes flow through Payments."],
      "operator",
    ),
  ],
} as const satisfies McpServiceDescriptor;
