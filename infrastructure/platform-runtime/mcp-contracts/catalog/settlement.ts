import {
  type McpJsonSchemaProperty,
  type McpServiceDescriptor,
  arrayProperty,
  booleanProperty,
  idempotencyKeyProperty,
  integerProperty,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

const settlementWalletOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    wallet: {
      type: "object",
      description: "Settlement wallet balance row.",
      additionalProperties: true,
      required: ["account_id", "currency_code", "pending_balance_amount", "available_balance_amount"],
      properties: {
        account_id: stringProperty("Account that owns the wallet."),
        currency_code: stringProperty("Wallet currency code."),
        pending_balance_amount: stringProperty("Pending balance amount."),
        available_balance_amount: stringProperty("Available balance amount."),
      },
    },
  },
  ["accountId", "wallet"],
);

const settlementLedgerEntryOutputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Settlement ledger entry row.",
  additionalProperties: true,
  required: ["ledger_entry_id", "account_id", "kind", "direction", "amount", "currency_code", "funds_status"],
  properties: {
    ledger_entry_id: stringProperty("Ledger entry identifier."),
    account_id: stringProperty("Account that owns the ledger entry."),
    kind: stringProperty("Ledger entry kind."),
    direction: stringProperty("Debit or credit direction."),
    amount: stringProperty("Ledger entry amount."),
    currency_code: stringProperty("Ledger entry currency code."),
    funds_status: stringProperty("Funds status."),
  },
};

const settlementLedgerEntriesOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    items: arrayProperty("Ledger entries visible to the actor.", settlementLedgerEntryOutputProperty),
    total: integerProperty("Total ledger entry count."),
    count: integerProperty("Returned ledger entry count."),
  },
  ["accountId", "items", "total", "count"],
);

const settlementPayoutOutputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Settlement payout row.",
  additionalProperties: true,
  required: ["payout_id", "account_id", "amount", "currency_code", "status", "requested_at", "updated_at"],
  properties: {
    payout_id: stringProperty("Payout identifier."),
    account_id: stringProperty("Account that owns the payout."),
    amount: stringProperty("Payout amount."),
    currency_code: stringProperty("Payout currency code."),
    status: stringProperty("Payout lifecycle status."),
    requested_at: stringProperty("Payout request timestamp."),
    updated_at: stringProperty("Payout update timestamp."),
  },
};

const settlementPayoutsOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    items: arrayProperty("Payouts visible to the actor.", settlementPayoutOutputProperty),
    total: integerProperty("Total payout count."),
    count: integerProperty("Returned payout count."),
  },
  ["accountId", "items", "total", "count"],
);

const settlementPayoutOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    payout: settlementPayoutOutputProperty,
  },
  ["accountId", "payout"],
);

const settlementPayoutReceiptOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Payout identifier."),
    payoutId: stringProperty("Payout identifier."),
    version: integerProperty("Committed payout stream version."),
    status: stringProperty("Payout lifecycle status."),
    resourceUri: stringProperty("MCP resource URI for the payout."),
    payout: settlementPayoutOutputProperty,
  },
  ["accountId", "id", "payoutId", "version", "status", "resourceUri", "payout"],
);

const settlementReadinessOutputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Settlement payout readiness row.",
  additionalProperties: true,
  required: ["account_id", "status", "missing_requirements", "onboarding_status", "updated_at"],
  properties: {
    account_id: stringProperty("Account that owns the readiness row."),
    status: stringProperty("Provider-neutral payout readiness status."),
    missing_requirements: arrayProperty("Provider-neutral missing requirement keys.", stringProperty("Requirement.")),
    provider_reference: stringProperty("Provider connected account reference."),
    onboarding_status: stringProperty("Provider-neutral onboarding status."),
    updated_at: stringProperty("Last readiness update timestamp."),
  },
};

const settlementReadinessReceiptOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Account identifier."),
    status: stringProperty("Provider-neutral payout readiness status."),
    readiness: settlementReadinessOutputProperty,
    resourceUri: stringProperty("MCP resource URI for the settlement wallet."),
  },
  ["accountId", "id", "status", "readiness", "resourceUri"],
);

const settlementHostedOnboardingLinkOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Provider connected account reference."),
    providerReference: stringProperty("Provider connected account reference."),
    status: stringProperty("Provider-neutral payout readiness status."),
    url: stringProperty("Hosted provider onboarding URL."),
    expiresAt: stringProperty("Hosted onboarding link expiration timestamp."),
    readiness: settlementReadinessOutputProperty,
  },
  ["accountId", "id", "providerReference", "status", "url", "readiness"],
);

export const settlementService = {
  ...service(
    "settlement",
    "Settlement",
    "bounded-contexts/settlement",
    "Wallets, ledger entries, payout readiness, payout requests, and reconciliation.",
    "payouts.view",
    ["wallet"],
    {
      packageName: "@chase-sets/settlement",
    },
  ),
  tools: [
    {
      ...readTool(
        "settlement",
        "get-wallet",
        "Get Wallet",
        "Read account wallet balance, pending funds, and payout readiness.",
        "payouts.view",
        objectSchema({ accountId: stringProperty("Authenticated account scope.") }, ["accountId"]),
        "wallet",
        ["Use before payout setup, payout request, or reconciliation actions."],
      ),
      availability: "available",
      outputSchema: settlementWalletOutputSchema,
    },
    {
      ...readTool(
        "settlement",
        "list-ledger-entries",
        "List Ledger Entries",
        "Read account ledger entries that explain wallet balance changes.",
        "payouts.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            limit: integerProperty("Maximum number of ledger entries to return."),
            offset: integerProperty("Number of ledger entries to skip."),
          },
          ["accountId"],
        ),
        "ledger-entry",
        ["Use when explaining balance changes or payout availability."],
      ),
      availability: "available",
      outputSchema: settlementLedgerEntriesOutputSchema,
    },
    {
      ...readTool(
        "settlement",
        "list-payouts",
        "List Payouts",
        "Read account payout request history.",
        "payouts.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            limit: integerProperty("Maximum number of payouts to return."),
            offset: integerProperty("Number of payouts to skip."),
          },
          ["accountId"],
        ),
        "payout",
        ["Use to inspect payout history before requesting or reconciling payouts."],
      ),
      availability: "available",
      outputSchema: settlementPayoutsOutputSchema,
    },
    {
      ...readTool(
        "settlement",
        "get-payout",
        "Get Payout",
        "Read one payout by identifier.",
        "payouts.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            payoutId: stringProperty("Payout identifier."),
          },
          ["accountId", "payoutId"],
        ),
        "payout",
        ["Use to inspect payout status, provider references, or failure details."],
      ),
      availability: "available",
      outputSchema: settlementPayoutOutputSchema,
    },
    {
      ...writeTool(
        "settlement",
        "request-payout",
        "Request Payout",
        "Request an account payout from available balance.",
        "payouts.request",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            amount: stringProperty("Payout amount in decimal currency format."),
            reason: stringProperty("Business reason for payout request."),
            sensitiveActionToken: stringProperty("Step-up verification token when required by payout policy."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate without requesting payout."),
          },
          ["accountId", "amount", "reason", "idempotencyKey", "confirmationText"],
        ),
        "payout",
        ["Use only after confirming available balance and payout readiness."],
        "sensitive",
      ),
      availability: "available",
      outputSchema: settlementPayoutReceiptOutputSchema,
    },
    {
      ...writeTool(
        "settlement",
        "refresh-readiness",
        "Refresh Payout Readiness",
        "Refresh payout readiness from the money movement provider.",
        "payouts.setup",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            providerReference: stringProperty("Optional expected connected payout account reference."),
            contactEmail: stringProperty("Optional account contact email for provider setup."),
            reason: stringProperty("Business reason for refreshing payout readiness."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate without refreshing readiness."),
          },
          ["accountId", "reason", "idempotencyKey", "confirmationText"],
        ),
        "payout-readiness",
        ["Use when setup status appears stale or after provider onboarding."],
        "sensitive",
      ),
      availability: "available",
      outputSchema: settlementReadinessReceiptOutputSchema,
    },
    {
      ...writeTool(
        "settlement",
        "create-payout-onboarding-link",
        "Create Payout Onboarding Link",
        "Create a hosted provider onboarding link for account payout setup.",
        "payouts.setup",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            returnUrl: stringProperty("HTTPS URL where the provider returns after onboarding."),
            refreshUrl: stringProperty("HTTPS URL where the provider sends expired-link recovery."),
            contactEmail: stringProperty("Optional account contact email for provider setup."),
            reason: stringProperty("Business reason for creating a hosted onboarding link."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate without creating a hosted link."),
          },
          ["accountId", "returnUrl", "refreshUrl", "reason", "idempotencyKey", "confirmationText"],
        ),
        "payout-readiness",
        ["Use when an agent-driven account needs a hosted Stripe Connect onboarding handoff."],
        "sensitive",
      ),
      availability: "available",
      outputSchema: settlementHostedOnboardingLinkOutputSchema,
    },
  ],
  resources: [
    {
      ...resource(
        "settlement",
        "chase-sets://settlement/{accountId}/wallet",
        "Wallet",
        "Wallet, ledger summary, and payout state.",
        "payouts.view",
        ["Use for payout and reconciliation decisions."],
      ),
      availability: "available",
    },
    {
      ...resource(
        "settlement",
        "chase-sets://settlement/{accountId}/payouts/{payoutId}",
        "Payout",
        "Payout status, provider references, and failure details.",
        "payouts.view",
        ["Use for payout status and reconciliation decisions."],
      ),
      availability: "available",
    },
  ],
} as const satisfies McpServiceDescriptor;
