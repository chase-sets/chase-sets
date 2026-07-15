// Universal Commerce Protocol (UCP) shopping profile for the 2026-04-08 spec.
// AP2 support in this package follows the UCP shopping AP2 mandate capability.
export const UCP_VERSION = "2026-04-08";
export const UCP_SPEC_BASE_URL = `https://ucp.dev/${UCP_VERSION}`;
export const UCP_LATEST_SPEC_BASE_URL = "https://ucp.dev/latest";

export const UCP_SHOPPING_SERVICE = "dev.ucp.shopping";

export const UCP_CAPABILITIES = {
  catalogSearch: "dev.ucp.shopping.catalog.search",
  catalogLookup: "dev.ucp.shopping.catalog.lookup",
  cart: "dev.ucp.shopping.cart",
  checkout: "dev.ucp.shopping.checkout",
  order: "dev.ucp.shopping.order",
  ap2Mandate: "dev.ucp.shopping.ap2_mandate",
  identityLinking: "dev.ucp.common.identity_linking",
} as const;

export const UCP_REST_ENDPOINT_PATH = "/ucp/v1";
export const UCP_MCP_ENDPOINT_PATH = "/ucp/mcp";

export type UcpTransport = "rest" | "mcp";
export type UcpResponseStatus = "ok" | "error" | "requires_action";
export type UcpMessageSeverity = "info" | "warning" | "error";

export type UcpServiceDeclaration = Readonly<{
  version: string;
  spec: string;
  transport: UcpTransport;
  schema: string;
  endpoint: string;
}>;

export type UcpCapabilityDeclaration = Readonly<{
  version: string;
  spec: string;
  schema: string;
  config?: Readonly<Record<string, unknown>>;
}>;

export type UcpSigningJsonWebKey = Readonly<
  JsonWebKey & {
    kid: string;
    use?: string;
  }
>;

export type UcpBusinessProfile = Readonly<{
  signing_keys?: readonly UcpSigningJsonWebKey[];
  ucp: Readonly<{
    version: string;
    services: Readonly<Record<string, readonly UcpServiceDeclaration[]>>;
    capabilities: Readonly<Record<string, readonly UcpCapabilityDeclaration[]>>;
    supported_versions: Readonly<Record<string, string>>;
    signing_keys?: readonly UcpSigningJsonWebKey[];
  }>;
}>;

export type UcpMessage = Readonly<{
  severity: UcpMessageSeverity;
  code: string;
  message: string;
  target?: string;
}>;

export type UcpEnvelope<TPayload extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> =
  Readonly<
    {
      ucp: Readonly<{
        version: string;
        status: UcpResponseStatus;
      }>;
      messages?: readonly UcpMessage[];
    } & TPayload
  >;

export type UcpMcpToolDescriptor = Readonly<{
  name: string;
  title: string;
  capability: (typeof UCP_CAPABILITIES)[keyof typeof UCP_CAPABILITIES];
  description: string;
  idempotencyKeyRequired: boolean;
  resultResourceUri?: string;
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema: Readonly<Record<string, unknown>>;
  securitySchemes: readonly UcpMcpSecurityScheme[];
  annotations: Readonly<{
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
    idempotentHint?: boolean;
  }>;
  invoking: string;
  invoked: string;
  trustedHandoffOnUnsignedMcp?: boolean;
}>;

export type UcpMcpResourceDescriptor = Readonly<{
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}>;

export type UcpMcpSecurityScheme =
  | Readonly<{ type: "noauth" }>
  | Readonly<{ type: "oauth2"; scopes: readonly string[] }>;

const UCP_ENVELOPE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    ucp: {
      type: "object",
      properties: {
        version: { type: "string" },
        status: { type: "string" },
      },
      required: ["version", "status"],
    },
    messages: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
  required: ["ucp"],
} as const;

const CATALOG_READ_SECURITY = [{ type: "noauth" }] as const;
const CHECKOUT_READ_SECURITY = [{ type: "oauth2", scopes: ["checkout:read"] }] as const;
const CHECKOUT_WRITE_SECURITY = [{ type: "oauth2", scopes: ["checkout:write"] }] as const;
const ORDER_READ_SECURITY = [{ type: "oauth2", scopes: ["order:read"] }] as const;

function readAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  } as const;
}

function writeAnnotations(
  params: Readonly<{
    destructive?: boolean;
    openWorld?: boolean;
    idempotent?: boolean;
  }> = {},
) {
  return {
    readOnlyHint: false,
    destructiveHint: params.destructive ?? false,
    openWorldHint: params.openWorld ?? false,
    ...(params.idempotent === undefined ? {} : { idempotentHint: params.idempotent }),
  } as const;
}

export const UCP_MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
export const UCP_MCP_PRODUCT_CARDS_RESOURCE_URI = "ui://chase-sets/product-cards/v1.html";
export const UCP_MCP_CART_REVIEW_RESOURCE_URI = "ui://chase-sets/cart-review/v1.html";
export const UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI = "ui://chase-sets/checkout-handoff/v1.html";
export const UCP_MCP_MARKETPLACE_RESULTS_RESOURCE_URI = UCP_MCP_PRODUCT_CARDS_RESOURCE_URI;

export const UCP_MCP_RESOURCES = [
  {
    uri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
    name: "product_cards",
    title: "Product Cards",
    description: "Renders Chase Sets marketplace products, price signals, availability, and product actions.",
    mimeType: UCP_MCP_APP_RESOURCE_MIME_TYPE,
  },
  {
    uri: UCP_MCP_CART_REVIEW_RESOURCE_URI,
    name: "cart_review",
    title: "Cart Review",
    description: "Renders checkout session lines, totals, shipping options, and review actions.",
    mimeType: UCP_MCP_APP_RESOURCE_MIME_TYPE,
  },
  {
    uri: UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
    name: "checkout_handoff",
    title: "Checkout Handoff",
    description: "Renders trusted checkout handoff state for final order and payment actions.",
    mimeType: UCP_MCP_APP_RESOURCE_MIME_TYPE,
  },
] as const satisfies readonly UcpMcpResourceDescriptor[];

export const UCP_MCP_TOOLS = [
  {
    name: "search_catalog",
    title: "Search Catalog",
    capability: UCP_CAPABILITIES.catalogSearch,
    description:
      "Use this when a ChatGPT user wants to find public Chase Sets marketplace products by query or simple filters. This only reads public marketplace discovery data.",
    idempotencyKeyRequired: false,
    resultResourceUri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Search text such as a card name, set, tag, or category." },
        limit: { type: "number", minimum: 1, maximum: 50 },
        cursor: { type: "string" },
        filters: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: { type: "string" },
            tag: { type: "string" },
            blueprintId: { type: "string" },
            language: { type: "string" },
          },
        },
      },
    },
    outputSchema: UCP_ENVELOPE_OUTPUT_SCHEMA,
    securitySchemes: CATALOG_READ_SECURITY,
    annotations: readAnnotations(),
    invoking: "Searching marketplace products",
    invoked: "Marketplace products found",
  },
  {
    name: "lookup_catalog",
    title: "Lookup Catalog",
    capability: UCP_CAPABILITIES.catalogLookup,
    description:
      "Use this when a ChatGPT user already has one or more Chase Sets product or catalog item identifiers and needs public marketplace product details.",
    idempotencyKeyRequired: false,
    resultResourceUri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Single catalog item or product identifier to resolve." },
        ids: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
          description: "Catalog item or product identifiers to resolve.",
        },
      },
    },
    outputSchema: UCP_ENVELOPE_OUTPUT_SCHEMA,
    securitySchemes: CATALOG_READ_SECURITY,
    annotations: readAnnotations(),
    invoking: "Looking up marketplace products",
    invoked: "Marketplace products resolved",
  },
  {
    name: "get_product",
    title: "Get Product",
    capability: UCP_CAPABILITIES.catalogLookup,
    description:
      "Use this when a ChatGPT user needs one public marketplace product detail, variants, account availability, and option-selection context.",
    idempotencyKeyRequired: false,
    resultResourceUri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Catalog item or product identifier to retrieve." },
      },
      required: ["id"],
    },
    outputSchema: UCP_ENVELOPE_OUTPUT_SCHEMA,
    securitySchemes: CATALOG_READ_SECURITY,
    annotations: readAnnotations(),
    invoking: "Loading product detail",
    invoked: "Product detail loaded",
  },
  {
    name: "create_checkout",
    title: "Create Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description:
      "Use this after the user chooses marketplace items to create a Chase Sets checkout session. This requires a linked buyer account and does not move money.",
    idempotencyKeyRequired: false,
    resultResourceUri: UCP_MCP_CART_REVIEW_RESOURCE_URI,
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        source: { type: "object", additionalProperties: true },
        intent: { type: "object", additionalProperties: true },
        type: { type: "string", enum: ["cart", "buy-now", "offer-intent", "offer"] },
        items: { type: "array", items: { type: "object", additionalProperties: true } },
        line_items: { type: "array", items: { type: "object", additionalProperties: true } },
        shipping_option: { type: "string" },
        optimization_goal: { type: "string", enum: ["fewest-shipments", "lowest-total"] },
      },
    },
    outputSchema: UCP_ENVELOPE_OUTPUT_SCHEMA,
    securitySchemes: CHECKOUT_WRITE_SECURITY,
    annotations: writeAnnotations(),
    invoking: "Creating checkout session",
    invoked: "Checkout session created",
  },
  {
    name: "get_checkout",
    title: "Get Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description:
      "Use this to read a checkout session for the linked buyer account. Do not use it for public product discovery.",
    idempotencyKeyRequired: false,
    resultResourceUri: UCP_MCP_CART_REVIEW_RESOURCE_URI,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Checkout session id." },
      },
      required: ["id"],
    },
    outputSchema: UCP_ENVELOPE_OUTPUT_SCHEMA,
    securitySchemes: CHECKOUT_READ_SECURITY,
    annotations: readAnnotations(),
    invoking: "Reading checkout session",
    invoked: "Checkout session loaded",
  },
  {
    name: "update_checkout",
    title: "Update Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description:
      "Use this to update shipping option, optimization goal, or shipping address on an existing Chase Sets checkout session. This requires a linked buyer account and does not move money.",
    idempotencyKeyRequired: false,
    resultResourceUri: UCP_MCP_CART_REVIEW_RESOURCE_URI,
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        id: { type: "string", description: "Checkout session id." },
        shipping_option: { type: "string" },
        optimization_goal: { type: "string", enum: ["fewest-shipments", "lowest-total"] },
        shipping_address: { type: "object", additionalProperties: true },
      },
      required: ["id"],
    },
    outputSchema: UCP_ENVELOPE_OUTPUT_SCHEMA,
    securitySchemes: CHECKOUT_WRITE_SECURITY,
    annotations: writeAnnotations(),
    invoking: "Updating checkout session",
    invoked: "Checkout session updated",
  },
  {
    name: "complete_checkout",
    title: "Complete Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description:
      "Use this only after the user asks to place the order. ChatGPT OAuth callers receive a trusted checkout handoff; signed UCP/AP2 agents may continue only when Payments verifies mandate support.",
    idempotencyKeyRequired: true,
    resultResourceUri: UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        id: { type: "string", description: "Checkout session id." },
        shipping_address: { type: "object", additionalProperties: true },
        acknowledged_material_changes: { type: "boolean" },
        marketplace_checkout_fee_quote_fingerprint: { type: "string" },
      },
      required: ["id"],
    },
    outputSchema: UCP_ENVELOPE_OUTPUT_SCHEMA,
    securitySchemes: CHECKOUT_WRITE_SECURITY,
    annotations: writeAnnotations({ destructive: true, openWorld: true }),
    invoking: "Preparing trusted checkout handoff",
    invoked: "Checkout handoff ready",
    trustedHandoffOnUnsignedMcp: true,
  },
  {
    name: "cancel_checkout",
    title: "Cancel Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description:
      "Use this only when the user asks to cancel or abandon checkout. Cancelling releases active checkout reservations before order or payment commitment.",
    idempotencyKeyRequired: true,
    resultResourceUri: UCP_MCP_CART_REVIEW_RESOURCE_URI,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Checkout session id." },
      },
      required: ["id"],
    },
    outputSchema: UCP_ENVELOPE_OUTPUT_SCHEMA,
    securitySchemes: CHECKOUT_WRITE_SECURITY,
    annotations: writeAnnotations({ destructive: true, idempotent: true }),
    invoking: "Cancelling checkout session",
    invoked: "Checkout session cancelled",
  },
  {
    name: "get_order",
    title: "Get Order",
    capability: UCP_CAPABILITIES.order,
    description: "Use this to retrieve a purchase or sale order for the linked buyer or seller account.",
    idempotencyKeyRequired: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Order id." },
      },
      required: ["id"],
    },
    outputSchema: UCP_ENVELOPE_OUTPUT_SCHEMA,
    securitySchemes: ORDER_READ_SECURITY,
    annotations: readAnnotations(),
    invoking: "Reading marketplace order",
    invoked: "Marketplace order loaded",
  },
] as const satisfies readonly UcpMcpToolDescriptor[];

export function normalizeUcpOrigin(origin: string) {
  return origin.replace(/\/+$/, "");
}

export function buildUcpBusinessProfile(
  origin: string,
  options: Readonly<{
    signingKeys?: readonly UcpSigningJsonWebKey[];
    ap2Readiness?: UcpAp2Readiness;
  }> = {},
): UcpBusinessProfile {
  const baseUrl = normalizeUcpOrigin(origin);
  const signingKeys = options.signingKeys?.length ? options.signingKeys : undefined;
  return {
    ...(signingKeys ? { signing_keys: signingKeys } : {}),
    ucp: {
      version: UCP_VERSION,
      ...(signingKeys ? { signing_keys: signingKeys } : {}),
      services: {
        [UCP_SHOPPING_SERVICE]: [
          {
            version: UCP_VERSION,
            spec: `${UCP_SPEC_BASE_URL}/specification/overview`,
            transport: "rest",
            schema: `${UCP_SPEC_BASE_URL}/services/shopping/rest.openapi.json`,
            endpoint: `${baseUrl}${UCP_REST_ENDPOINT_PATH}`,
          },
          {
            version: UCP_VERSION,
            spec: `${UCP_SPEC_BASE_URL}/specification/overview`,
            transport: "mcp",
            schema: `${UCP_SPEC_BASE_URL}/services/shopping/mcp.openrpc.json`,
            endpoint: `${baseUrl}${UCP_MCP_ENDPOINT_PATH}`,
          },
        ],
      },
      capabilities: {
        [UCP_CAPABILITIES.catalogSearch]: [capability("catalog/search", "shopping/catalog_search.json")],
        [UCP_CAPABILITIES.catalogLookup]: [capability("catalog/lookup", "shopping/catalog_lookup.json")],
        [UCP_CAPABILITIES.checkout]: [
          capability("checkout", "shopping/checkout.json", {
            completion_requires_trusted_ui_without_ap2_mandate: true,
          }),
        ],
        [UCP_CAPABILITIES.order]: [capability("order", "shopping/order.json")],
        [UCP_CAPABILITIES.identityLinking]: [
          capability("identity-linking", "common/identity_linking.json", {
            oauth_authorization_server: `${baseUrl}/.well-known/oauth-authorization-server`,
          }),
        ],
        [UCP_CAPABILITIES.ap2Mandate]: [
          capability("ap2-mandates", "shopping/ap2_mandate.json", {
            status: options.ap2Readiness?.headlessCompletionEnabled
              ? "human_present_enabled"
              : signingKeys
                ? "merchant_authorization_available"
                : "guarded_scaffold",
            business_response_signing: signingKeys ? "enabled" : "not-configured",
            mandate_verification: options.ap2Readiness?.mandateVerification ?? "not-enabled",
            shared_payment_token: options.ap2Readiness?.sharedPaymentToken ?? "not-enabled",
            supported_modes: ["human-present"],
            headless_completion_enabled: options.ap2Readiness?.headlessCompletionEnabled ?? false,
            human_present_completion_enabled: options.ap2Readiness?.headlessCompletionEnabled ?? false,
            human_not_present_completion_enabled: false,
          }),
        ],
      },
      supported_versions: {
        [UCP_VERSION]: `${baseUrl}/.well-known/ucp`,
      },
    },
  };
}

export type UcpAp2Readiness = Readonly<{
  mandateVerification: "enabled" | "not-enabled";
  sharedPaymentToken: "enabled" | "not-enabled";
  headlessCompletionEnabled: boolean;
}>;

export function createUcpEnvelope<TPayload extends Readonly<Record<string, unknown>>>(
  status: UcpResponseStatus,
  payload: TPayload,
  messages: readonly UcpMessage[] = [],
): UcpEnvelope<TPayload> {
  return {
    ucp: {
      version: UCP_VERSION,
      status,
    },
    ...(messages.length > 0 ? { messages } : {}),
    ...payload,
  };
}

export function unsupportedUcpOperation(operation: string): UcpEnvelope {
  return createUcpEnvelope("error", {}, [
    {
      severity: "error",
      code: "operation_not_wired",
      message: `${operation} is advertised by the UCP contract but is not wired to an owning bounded-context handler in this runtime yet.`,
    },
  ]);
}

function capability(
  specPath: string,
  schemaPath: string,
  config?: Readonly<Record<string, unknown>>,
): UcpCapabilityDeclaration {
  return {
    version: UCP_VERSION,
    spec: `${UCP_SPEC_BASE_URL}/specification/${specPath}`,
    schema: `${UCP_SPEC_BASE_URL}/schemas/${schemaPath}`,
    ...(config ? { config } : {}),
  };
}
