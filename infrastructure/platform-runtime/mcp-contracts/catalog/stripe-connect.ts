import {
  type McpServiceDescriptor,
  mutationInput,
  objectSchema,
  readTool,
  resource,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

export const stripeConnectService = {
  serviceId: "stripe-connect",
  serviceName: "Stripe Connect",
  kind: "external-provider",
  owner: "infrastructure/stripe-connect",
  packageName: "@chase-sets/stripe-connect",
  serviceBoundary:
    "Provider adapter for payout accounts, platform balance transfers, connected-account payouts, and money movement webhooks.",
  tools: [
    readTool(
      "stripe-connect",
      "inspect-payout-readiness",
      "Inspect Stripe Payout Readiness",
      "Inspect support-safe payout readiness for a connected account.",
      "payouts.reconcile",
      objectSchema(
        {
          accountId: stringProperty("Account identifier."),
          providerReference: stringProperty("Stripe connected account reference."),
        },
        ["accountId", "providerReference"],
      ),
      "provider-payout-readiness",
      ["Use after checking Settlement readiness when provider state must be explained."],
      "operator",
    ),
    writeTool(
      "stripe-connect",
      "replay-webhook",
      "Replay Stripe Connect Webhook",
      "Replay a captured money movement webhook through the provider webhook inbox.",
      "payouts.reconcile",
      mutationInput("providerEventId", "Provider event to replay."),
      "provider-webhook",
      ["Use only for confirmed reconciliation recovery."],
      "sensitive",
      "operator",
    ),
  ],
  resources: [
    resource(
      "stripe-connect",
      "chase-sets://providers/stripe-connect/accounts/{providerReference}",
      "Stripe Connected Account Diagnostic",
      "Support-safe provider payout account state.",
      "payouts.reconcile",
      ["Use for payout support and reconciliation diagnostics."],
      "operator",
    ),
  ],
} as const satisfies McpServiceDescriptor;
