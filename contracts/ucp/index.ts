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

export type UcpBusinessProfile = Readonly<{
  signing_keys?: readonly JsonWebKey[];
  ucp: Readonly<{
    version: string;
    services: Readonly<Record<string, readonly UcpServiceDeclaration[]>>;
    capabilities: Readonly<Record<string, readonly UcpCapabilityDeclaration[]>>;
    supported_versions: Readonly<Record<string, string>>;
    signing_keys?: readonly JsonWebKey[];
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
}>;

export const UCP_MCP_TOOLS = [
  {
    name: "search_catalog",
    title: "Search Catalog",
    capability: UCP_CAPABILITIES.catalogSearch,
    description: "Search buyer-visible marketplace products by query and filters.",
    idempotencyKeyRequired: false,
  },
  {
    name: "lookup_catalog",
    title: "Lookup Catalog",
    capability: UCP_CAPABILITIES.catalogLookup,
    description: "Resolve product or variant identifiers into buyer-visible product records.",
    idempotencyKeyRequired: false,
  },
  {
    name: "get_product",
    title: "Get Product",
    capability: UCP_CAPABILITIES.catalogLookup,
    description: "Retrieve one product with option-selection and availability context.",
    idempotencyKeyRequired: false,
  },
  {
    name: "create_checkout",
    title: "Create Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description: "Create a checkout session from agent-provided purchase intent.",
    idempotencyKeyRequired: false,
  },
  {
    name: "get_checkout",
    title: "Get Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description: "Read the current state of a checkout session.",
    idempotencyKeyRequired: false,
  },
  {
    name: "update_checkout",
    title: "Update Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description: "Update buyer, fulfillment, or payment-selection details on a checkout session.",
    idempotencyKeyRequired: false,
  },
  {
    name: "complete_checkout",
    title: "Complete Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description: "Attempt to place the order, requiring trusted UI escalation unless AP2 mandate support is present.",
    idempotencyKeyRequired: true,
  },
  {
    name: "cancel_checkout",
    title: "Cancel Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description: "Cancel a checkout session.",
    idempotencyKeyRequired: true,
  },
  {
    name: "get_order",
    title: "Get Order",
    capability: UCP_CAPABILITIES.order,
    description: "Retrieve the current state of an order for the linked buyer or seller account.",
    idempotencyKeyRequired: false,
  },
] as const satisfies readonly UcpMcpToolDescriptor[];

export function normalizeUcpOrigin(origin: string) {
  return origin.replace(/\/+$/, "");
}

export function buildUcpBusinessProfile(
  origin: string,
  options: Readonly<{ signingKeys?: readonly JsonWebKey[] }> = {},
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
        [UCP_CAPABILITIES.catalogSearch]: [
          capability("catalog/search", "shopping/catalog_search.json"),
        ],
        [UCP_CAPABILITIES.catalogLookup]: [
          capability("catalog/lookup", "shopping/catalog_lookup.json"),
        ],
        [UCP_CAPABILITIES.checkout]: [
          capability("checkout", "shopping/checkout.json", {
            completion_requires_trusted_ui_without_ap2_mandate: true,
          }),
        ],
        [UCP_CAPABILITIES.order]: [
          capability("order", "shopping/order.json"),
        ],
        [UCP_CAPABILITIES.identityLinking]: [
          capability("identity-linking", "common/identity_linking.json", {
            oauth_authorization_server: `${baseUrl}/.well-known/oauth-authorization-server`,
          }),
        ],
        [UCP_CAPABILITIES.ap2Mandate]: [
          capability("ap2-mandates", "shopping/ap2_mandate.json", {
            status: signingKeys ? "merchant_authorization_available" : "guarded_scaffold",
            business_response_signing: signingKeys ? "enabled" : "not-configured",
            headless_completion_enabled: false,
          }),
        ],
      },
      supported_versions: {
        [UCP_VERSION]: `${baseUrl}/.well-known/ucp`,
      },
    },
  };
}

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
