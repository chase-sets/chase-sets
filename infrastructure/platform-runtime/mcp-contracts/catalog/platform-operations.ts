import {
  type McpServiceDescriptor,
  accountScopedDetailOutputSchema,
  accountScopedListOutputSchema,
  integerProperty,
  objectSchema,
  readTool,
  resource,
  stringProperty,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

export const platformOperationsService = {
  serviceId: "platform-operations",
  serviceName: "Platform Operations",
  kind: "bounded-context",
  owner: "bounded-contexts/platform-operations",
  packageName: "@chase-sets/platform-operations",
  serviceBoundary: "Operator workflows, support read models, risk queues, and current insight dashboard reads.",
  tools: [
    {
      ...readTool(
        "platform-operations",
        "get-seller-insight-summary",
        "Get Seller Insight Summary",
        "Read seller dashboard KPIs currently exposed by Platform Operations insights dashboards.",
        "accounts.view",
        objectSchema({ accountId: stringProperty("Authenticated account scope.") }, ["accountId"]),
        "seller-insight-summary",
        ["Use for non-mutating seller performance analysis."],
      ),
      availability: "available",
    },
    {
      ...readTool(
        "platform-operations",
        "list-support-requests",
        "List Support Requests",
        "List buyer or seller support requests visible to the actor.",
        "support.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            side: stringProperty("Support request side.", ["buyer", "seller"]),
            limit: integerProperty("Maximum records to return."),
            offset: integerProperty("Zero-based record offset."),
          },
          ["accountId"],
        ),
        "support-request",
        ["Use to find refund, dispute, return, or delivery support status for an account."],
      ),
      availability: "available",
      outputSchema: accountScopedListOutputSchema("Support request rows visible to the actor."),
    },
    {
      ...readTool(
        "platform-operations",
        "get-support-request",
        "Get Support Request",
        "Read support request status, pending offers, resolution, and evidence visible to the actor.",
        "support.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            supportRequestId: stringProperty("Support request identifier."),
          },
          ["accountId", "supportRequestId"],
        ),
        "support-request",
        ["Use to answer refund, dispute, return, or delivery support status questions."],
      ),
      availability: "available",
      outputSchema: accountScopedDetailOutputSchema("supportRequest", "Support request detail and status."),
    },
    {
      ...readTool(
        "platform-operations",
        "get-offer-economics-summary",
        "Get Offer Economics Summary",
        "Read the founders 0%-locked-fee cohort's listing volume, realized GMV share of the platform, foregone-fee estimate, and cumulative sell-through trend for a date range.",
        "insights-dashboards.view",
        objectSchema(
          {
            from: stringProperty("Inclusive range start, YYYY-MM-DD. Defaults to 59 days before 'to'."),
            to: stringProperty("Inclusive range end, YYYY-MM-DD. Defaults to today."),
            accountType: stringProperty(
              "Account type the foregone-fee estimate's standard schedule basis is resolved for.",
              ["personal", "business", "enterprise"],
            ),
          },
          [],
        ),
        "offer-economics-summary",
        [
          "Use to check whether a public campaign fee claim is substantiated before citing it.",
          "Use for founders-offer cohort economics review, not any single account's own fees.",
        ],
        "operator",
      ),
      availability: "available",
    },
  ],
  resources: [
    {
      ...resource(
        "platform-operations",
        "chase-sets://platform-operations/{accountId}/insights/summary",
        "Seller Insight Summary",
        "Sales performance, fulfillment latency, and conversion KPI summary.",
        "accounts.view",
        ["Use for seller dashboard analysis."],
      ),
      availability: "available",
    },
    {
      ...resource(
        "platform-operations",
        "chase-sets://platform-operations/{accountId}/support-requests/{supportRequestId}",
        "Support Request",
        "Support request detail, resolution, pending offers, and refund-support status.",
        "support.view",
        ["Use for post-purchase support status and refund/dispute explanations."],
      ),
      availability: "available",
    },
    {
      ...resource(
        "platform-operations",
        "chase-sets://platform-operations/offer-economics/summary",
        "Offer Economics Summary",
        "Founders 0%-locked-fee cohort listing volume, GMV share, foregone-fee estimate, and sell-through trend, trailing 60 days.",
        "insights-dashboards.view",
        ["Use to check whether a public campaign fee claim is substantiated before citing it."],
        "operator",
      ),
      availability: "available",
    },
  ],
} as const satisfies McpServiceDescriptor;
