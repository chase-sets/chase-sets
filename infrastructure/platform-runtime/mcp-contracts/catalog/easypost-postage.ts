import {
  type McpServiceDescriptor,
  mutationInput,
  objectSchema,
  readTool,
  resource,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

export const easypostPostageService = {
  serviceId: "easypost-postage",
  serviceName: "EasyPost Postage",
  kind: "external-provider",
  owner: "infrastructure/easypost-postage",
  packageName: "@chase-sets/easypost-postage",
  serviceBoundary:
    "Provider adapter for USPS label purchase and voiding. Agents should prefer Fulfillment tools except for support-safe provider diagnostics.",
  tools: [
    readTool(
      "easypost-postage",
      "inspect-label",
      "Inspect EasyPost Label",
      "Inspect support-safe provider label status.",
      "fulfillment.view",
      objectSchema(
        {
          shipmentId: stringProperty("Shipment identifier."),
          providerLabelId: stringProperty("EasyPost label identifier."),
        },
        ["shipmentId", "providerLabelId"],
      ),
      "provider-label",
      ["Use after checking the Fulfillment shipment read model."],
      "operator",
    ),
    writeTool(
      "easypost-postage",
      "replay-tracking-event",
      "Replay Tracking Event",
      "Replay a captured tracking webhook through the provider webhook inbox.",
      "fulfillment.manage",
      mutationInput("providerEventId", "Provider event to replay."),
      "provider-webhook",
      ["Use only for confirmed fulfillment support recovery."],
      "sensitive",
      "operator",
    ),
  ],
  resources: [
    resource(
      "easypost-postage",
      "chase-sets://providers/easypost/labels/{providerLabelId}",
      "EasyPost Label Diagnostic",
      "Support-safe provider label diagnostic view.",
      "fulfillment.view",
      ["Use for label support diagnostics; purchase and void writes flow through Fulfillment."],
      "operator",
    ),
  ],
} as const satisfies McpServiceDescriptor;
