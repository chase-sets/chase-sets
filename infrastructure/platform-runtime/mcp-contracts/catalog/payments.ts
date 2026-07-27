import {
  type McpServiceDescriptor,
  arrayProperty,
  booleanProperty,
  idempotencyKeyProperty,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

const paymentsPaymentStatusOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    payment: {
      type: "object",
      description: "Payments payment detail row.",
      additionalProperties: true,
      required: ["payment_id", "buyer_account_id", "status", "processor_status", "refunded_amount"],
      properties: {
        payment_id: stringProperty("Payment identifier."),
        buyer_account_id: stringProperty("Buyer account identifier."),
        status: stringProperty("Current payment status."),
        processor_status: stringProperty("Processor status mirrored into Payments."),
        refunded_amount: stringProperty("Total refunded amount."),
      },
    },
    moneyTimeline: {
      type: "object",
      description: "Payment money-movement timeline.",
      additionalProperties: true,
      properties: {},
    },
    status: {
      type: "object",
      description: "Compact payment, refund, and dispute status.",
      additionalProperties: true,
      required: ["paymentStatus", "processorStatus", "refundedAmount"],
      properties: {
        paymentStatus: stringProperty("Current payment status."),
        processorStatus: stringProperty("Current processor status."),
        refundedAmount: stringProperty("Total refunded amount."),
        refundedAt: stringProperty("Refund timestamp when present."),
        disputedAt: stringProperty("Dispute timestamp when present."),
        failureCode: stringProperty("Failure code when present."),
        failureMessage: stringProperty("Failure message when present."),
      },
    },
  },
  ["accountId", "payment", "moneyTimeline", "status"],
);

const paymentsRefundStatusOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    paymentId: stringProperty("Payment identifier."),
    orderIds: arrayProperty("Order identifiers paid by the payment.", stringProperty("Order identifier.")),
    status: {
      type: "object",
      description: "Compact payment, refund, and dispute status.",
      additionalProperties: true,
      properties: {},
    },
    orderRefundCaps: arrayProperty("Per-order refund caps.", {
      type: "object",
      description: "Order refund cap.",
      additionalProperties: true,
      properties: {},
    }),
    orderRefundedAmounts: arrayProperty("Per-order refunded amounts.", {
      type: "object",
      description: "Order refunded amount.",
      additionalProperties: true,
      properties: {},
    }),
    moneyTimeline: {
      type: "object",
      description: "Payment money-movement timeline.",
      additionalProperties: true,
      properties: {},
    },
  },
  ["accountId", "paymentId", "orderIds", "status", "orderRefundCaps", "orderRefundedAmounts", "moneyTimeline"],
);

const paymentsPaymentMethodSetupOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Payment-method setup reference."),
    setupReferenceId: stringProperty("Payment-method setup reference to poll for attachment."),
    status: stringProperty("Provider-neutral setup session status."),
    url: stringProperty("Hosted HTTPS card-setup page URL. No client secret is exposed."),
    consentText: stringProperty("Consent text the buyer accepts when saving the payment method."),
  },
  ["accountId", "id", "setupReferenceId", "status", "url", "consentText"],
);

const paymentsPaymentMethodConfirmationOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    setupReferenceId: stringProperty("Payment-method setup reference that was polled."),
    attached: booleanProperty("Whether a payment method is now attached to the account."),
    status: stringProperty("Attachment status: attached or pending."),
    paymentMethod: {
      type: "object",
      description: "Display-safe stored payment-method facts. No provider reference or fingerprint.",
      additionalProperties: true,
      required: ["instrumentId", "displayLabel", "paymentMethodCategory", "isDefault", "readiness"],
      properties: {
        instrumentId: stringProperty("Chase Sets stored payment-method identifier."),
        displayLabel: stringProperty("Display label, e.g. brand and last four digits."),
        paymentMethodCategory: stringProperty("Payment-method category."),
        isDefault: booleanProperty("Whether this is the account default payment method."),
        readiness: stringProperty("Stored payment-method readiness."),
      },
    },
  },
  ["accountId", "setupReferenceId", "attached", "status"],
);

export const paymentsService = {
  ...service(
    "payments",
    "Payments",
    "bounded-contexts/payments",
    "Payment sessions, payment events, refunds, and provider webhook normalization.",
    "orders.view",
    ["payment"],
    {
      packageName: "@chase-sets/payments",
    },
  ),
  tools: [
    {
      ...writeTool(
        "payments",
        "start-payment-method-setup",
        "Start Payment Method Setup",
        "Create a one-time Stripe-hosted card-setup page and return its HTTPS URL for URL-mode elicitation. A card number never transits chat; the buyer enters it on the hosted page.",
        "orders.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            returnUrl: stringProperty("HTTPS URL where the hosted page returns after card setup."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate without creating a hosted setup session."),
          },
          ["accountId", "returnUrl", "idempotencyKey", "confirmationText"],
        ),
        "payment-method-setup",
        [
          "Use once, before in-chat checkout completion, when the account has no stored payment method.",
          "Return the hosted URL to the user for a one-time card-entry hop; then poll confirm-payment-method-setup.",
        ],
        "sensitive",
      ),
      availability: "available",
      outputSchema: paymentsPaymentMethodSetupOutputSchema,
    },
    {
      ...readTool(
        "payments",
        "confirm-payment-method-setup",
        "Confirm Payment Method Setup",
        "Poll a payment-method setup session and confirm whether a stored payment method is now attached to the account.",
        "orders.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            setupReferenceId: stringProperty("Setup reference returned by start-payment-method-setup."),
          },
          ["accountId", "setupReferenceId"],
        ),
        "payment-method-setup",
        ["Poll after directing the user to the hosted setup URL, until attachment is confirmed."],
      ),
      availability: "available",
      outputSchema: paymentsPaymentMethodConfirmationOutputSchema,
    },
    {
      ...readTool(
        "payments",
        "get-payment",
        "Get Payment",
        "Read payment and refund state for an order payment.",
        "orders.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            paymentId: stringProperty("Payment identifier."),
          },
          ["accountId", "paymentId"],
        ),
        "payment",
        ["Use before refund, support, or order readiness actions."],
      ),
      availability: "available",
      outputSchema: paymentsPaymentStatusOutputSchema,
    },
    {
      ...readTool(
        "payments",
        "get-refund-status",
        "Get Refund Status",
        "Read refund and dispute status for an account payment.",
        "orders.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            paymentId: stringProperty("Payment identifier."),
          },
          ["accountId", "paymentId"],
        ),
        "refund",
        ["Use before explaining refund outcomes, dispute status, or support resolution state."],
      ),
      availability: "available",
      outputSchema: paymentsRefundStatusOutputSchema,
    },
    writeTool(
      "payments",
      "request-refund",
      "Request Refund",
      "Request a payment refund through the owning payment workflow.",
      "orders.manage",
      objectSchema(
        {
          accountId: stringProperty("Authenticated account scope."),
          paymentId: stringProperty("Payment identifier."),
          amount: stringProperty("Refund amount in decimal currency format."),
          reason: stringProperty("Business reason for the refund."),
          idempotencyKey: idempotencyKeyProperty(),
          confirmationText: stringProperty("Exact user or policy confirmation text."),
          dryRun: booleanProperty("Validate without requesting the refund."),
        },
        ["accountId", "paymentId", "amount", "reason", "idempotencyKey", "confirmationText"],
      ),
      "refund",
      ["Use only after order policy and participant intent are confirmed."],
      "sensitive",
    ),
  ],
  resources: [
    {
      ...resource(
        "payments",
        "chase-sets://payments/{accountId}/payments/{paymentId}",
        "Payment",
        "Payment processor status projected into Chase Sets.",
        "orders.view",
        ["Use for payment support and order readiness checks."],
      ),
      availability: "available",
    },
  ],
} as const satisfies McpServiceDescriptor;
