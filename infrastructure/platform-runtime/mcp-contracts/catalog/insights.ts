import {
  type McpServiceDescriptor,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

export const insightsService = {
  ...service(
    "insights",
    "Insights",
    "bounded-contexts/platform-operations",
    "Marketplace analytics, account performance summaries, and operational insights.",
    "accounts.view",
    ["insight"],
    {
      packageName: "@chase-sets/platform-operations",
    },
  ),
  tools: [
    readTool(
      "insights",
      "get-account-summary",
      "Get Account Summary",
      "Read account performance and marketplace workflow summary.",
      "accounts.view",
      objectSchema(
        { accountId: stringProperty("Authenticated account scope."), period: stringProperty("Reporting period.") },
        ["accountId", "period"],
      ),
      "insight",
      ["Use for non-mutating analysis and account health explanations."],
    ),
  ],
  resources: [
    resource(
      "insights",
      "chase-sets://insights/{accountId}/summary",
      "Account Insight Summary",
      "Aggregated operational insight read model.",
      "accounts.view",
      ["Use for analysis and recommendation context."],
    ),
  ],
} as const satisfies McpServiceDescriptor;
