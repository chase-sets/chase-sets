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

export const commercialTermsService = {
  ...service(
    "commercial-terms",
    "Commercial Terms",
    "bounded-contexts/commercial-terms",
    "Agreement schedules, fee terms, settlement terms, and order/listing term resolution.",
    "commercial-terms.view",
    ["agreement"],
    {
      packageName: "@chase-sets/commercial-terms",
    },
  ),
  tools: [
    readTool(
      "commercial-terms",
      "resolve-listing-terms",
      "Resolve Listing Terms",
      "Resolve terms that apply to a listing or account sale workflow.",
      "commercial-terms.view",
      objectSchema(
        {
          accountId: stringProperty("Authenticated account scope."),
          listingId: stringProperty("Listing identifier."),
        },
        ["accountId", "listingId"],
      ),
      "terms-resolution",
      ["Use before publishing listings or accepting offers."],
    ),
    writeTool(
      "commercial-terms",
      "publish-schedule",
      "Publish Terms Schedule",
      "Publish a commercial terms schedule.",
      "commercial-terms.manage",
      mutationInput("scheduleId", "Terms schedule to publish."),
      "terms-schedule",
      ["Use only for explicit policy administration changes."],
      "sensitive",
      "operator",
    ),
  ],
  resources: [
    resource(
      "commercial-terms",
      "chase-sets://commercial-terms/{accountId}/agreements/{agreementId}",
      "Agreement",
      "Commercial agreement and applied schedule state.",
      "commercial-terms.view",
      ["Use to inspect fee and payout terms."],
    ),
  ],
} as const satisfies McpServiceDescriptor;
