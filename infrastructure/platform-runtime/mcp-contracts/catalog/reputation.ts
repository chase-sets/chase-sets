import {
  type McpServiceDescriptor,
  mutationInput,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

export const reputationService = {
  ...service(
    "reputation",
    "Reputation",
    "bounded-contexts/marketplace",
    "Reviews, review summaries, and reputation signals for purchases and sales.",
    "reputation.view",
    ["review"],
    {
      packageName: "@chase-sets/marketplace",
    },
  ),
  tools: [
    readTool(
      "reputation",
      "get-summary",
      "Get Reputation Summary",
      "Read account reputation summary.",
      "reputation.view",
      objectSchema(
        {
          accountId: stringProperty("Authenticated account scope."),
          subjectAccountId: stringProperty("Account being reviewed."),
        },
        ["accountId", "subjectAccountId"],
      ),
      "review-summary",
      ["Use before writing reviews or explaining seller/buyer history."],
    ),
    writeTool(
      "reputation",
      "submit-review",
      "Submit Review",
      "Submit a review for an eligible purchase or sale.",
      "reputation.manage",
      mutationInput("orderId", "Order being reviewed."),
      "review",
      ["Use only when the actor explicitly confirms rating and review text."],
      "sensitive",
    ),
  ],
  resources: [
    resource(
      "reputation",
      "chase-sets://reputation/{accountId}/summaries/{subjectAccountId}",
      "Reputation Summary",
      "Review rollup and participant-safe history.",
      "reputation.view",
      ["Use for trust and review workflows."],
    ),
  ],
} as const satisfies McpServiceDescriptor;
