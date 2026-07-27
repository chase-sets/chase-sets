import {
  type McpServiceDescriptor,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

export const authenticityService = {
  ...service(
    "authenticity",
    "Authenticity",
    "bounded-contexts/authenticity",
    "Authenticity case lifecycle: judgment records for authenticity-checked orders.",
    "authenticity.view",
    ["authenticity-case"],
    {
      packageName: "@chase-sets/authenticity",
    },
  ),
  tools: [
    {
      ...readTool(
        "authenticity",
        "get-case-status",
        "Get Authenticity Case Status",
        "Read the authenticity case status for an order.",
        "authenticity.view",
        objectSchema({ orderId: stringProperty("Order identifier.") }, ["orderId"]),
        "authenticity-case",
        ["Use to check whether an order's authenticity check has passed, failed, or is still in progress."],
      ),
      availability: "available",
    },
  ],
  resources: [
    {
      ...resource(
        "authenticity",
        "chase-sets://authenticity/cases/{caseId}",
        "Authenticity Case",
        "Authenticity case read model: lifecycle status, verdict, and reason codes.",
        "authenticity.view",
        ["Use to read the full case record once the case id is known."],
      ),
      availability: "available",
    },
  ],
} as const satisfies McpServiceDescriptor;
