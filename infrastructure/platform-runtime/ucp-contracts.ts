import { moneyToCents } from "@chase-sets/primitives/money";

// Universal Commerce Protocol (UCP) shopping profile for the 2026-08-25 spec.
export const UCP_VERSION = "2026-08-25";
export const UCP_SPEC_BASE_URL = `https://ucp.dev/${UCP_VERSION}`;
export const UCP_LATEST_SPEC_BASE_URL = "https://ucp.dev/latest";

export const UCP_SHOPPING_SERVICE = "dev.ucp.shopping";

export const UCP_CAPABILITIES = {
  catalogSearch: "dev.ucp.shopping.catalog.search",
  catalogLookup: "dev.ucp.shopping.catalog.lookup",
  cart: "dev.ucp.shopping.cart",
  checkout: "dev.ucp.shopping.checkout",
  order: "dev.ucp.shopping.order",
  identityLinking: "dev.ucp.common.identity_linking",
} as const;

export const UCP_REST_ENDPOINT_PATH = "/ucp/v1";
export const UCP_MCP_ENDPOINT_PATH = "/ucp/mcp";

export function moneyToMinorUnits(value: string): number {
  return Number(moneyToCents(value));
}

export type UcpTransport = "rest" | "mcp";
export type UcpResponseStatus = "success" | "error";
export type UcpMessageSeverity = "recoverable" | "unrecoverable" | "requires_buyer_input" | "requires_buyer_review";

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
  keys?: readonly UcpSigningJsonWebKey[];
  ucp: Readonly<{
    version: string;
    services: Readonly<Record<string, readonly UcpServiceDeclaration[]>>;
    capabilities: Readonly<Record<string, readonly UcpCapabilityDeclaration[]>>;
    payment_handlers: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
  }>;
}>;

export type UcpMessage = Readonly<{
  type?: "error";
  severity: UcpMessageSeverity;
  code: string;
  content?: string;
  message?: string;
  path?: string;
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

const ERROR_RESPONSE_SCHEMA = {
  $ref: "https://ucp.dev/2026-08-25/schemas/common/types/error_response.json",
} as const;

const CHECKOUT_OUTPUT_SCHEMA = {
  anyOf: [{ $ref: "https://ucp.dev/2026-08-25/schemas/shopping/checkout.json" }, ERROR_RESPONSE_SCHEMA],
} as const;
const ORDER_OUTPUT_SCHEMA = {
  anyOf: [{ $ref: "https://ucp.dev/2026-08-25/schemas/shopping/order.json" }, ERROR_RESPONSE_SCHEMA],
} as const;
const CATALOG_SEARCH_OUTPUT_SCHEMA = {
  anyOf: [
    { $ref: "https://ucp.dev/2026-08-25/schemas/shopping/catalog_search.json#/$defs/search_response" },
    ERROR_RESPONSE_SCHEMA,
  ],
} as const;
const CATALOG_LOOKUP_OUTPUT_SCHEMA = {
  anyOf: [
    { $ref: "https://ucp.dev/2026-08-25/schemas/shopping/catalog_lookup.json#/$defs/lookup_response" },
    ERROR_RESPONSE_SCHEMA,
  ],
} as const;
const CATALOG_GET_PRODUCT_OUTPUT_SCHEMA = {
  anyOf: [
    { $ref: "https://ucp.dev/2026-08-25/schemas/shopping/catalog_lookup.json#/$defs/get_product_response" },
    ERROR_RESPONSE_SCHEMA,
  ],
} as const;

const CATALOG_READ_SECURITY = [{ type: "noauth" }] as const;
const CHECKOUT_MANAGE_SECURITY = [{ type: "oauth2", scopes: ["dev.ucp.shopping.checkout:manage"] }] as const;
const ORDER_READ_SECURITY = [{ type: "oauth2", scopes: ["dev.ucp.shopping.order:read"] }] as const;
const UCP_META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    "ucp-agent": { type: "object", properties: { profile: { type: "string", format: "uri" } }, required: ["profile"] },
    "idempotency-key": { type: "string" },
  },
} as const;

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

const checkoutResourceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          item: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          quantity: { type: "integer", minimum: 1 },
          quantity_unit: {
            type: "object",
            properties: { unit: { const: "C62" }, scale: { const: 0 } },
            required: ["unit", "scale"],
          },
        },
        required: ["item", "quantity"],
      },
    },
  },
  required: ["line_items"],
} as const;

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
        meta: UCP_META_SCHEMA,
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
    outputSchema: CATALOG_SEARCH_OUTPUT_SCHEMA,
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
        meta: UCP_META_SCHEMA,
        id: { type: "string", description: "Single catalog item or product identifier to resolve." },
        ids: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
          description: "Catalog item or product identifiers to resolve.",
        },
      },
    },
    outputSchema: CATALOG_LOOKUP_OUTPUT_SCHEMA,
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
        meta: UCP_META_SCHEMA,
        id: { type: "string", description: "Catalog item or product identifier to retrieve." },
      },
      required: ["id"],
    },
    outputSchema: CATALOG_GET_PRODUCT_OUTPUT_SCHEMA,
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
      additionalProperties: false,
      properties: { meta: UCP_META_SCHEMA, checkout: checkoutResourceSchema },
      required: ["checkout"],
    },
    outputSchema: CHECKOUT_OUTPUT_SCHEMA,
    securitySchemes: CHECKOUT_MANAGE_SECURITY,
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
        meta: UCP_META_SCHEMA,
        id: { type: "string", description: "Checkout session id." },
      },
      required: ["id"],
    },
    outputSchema: CHECKOUT_OUTPUT_SCHEMA,
    securitySchemes: CHECKOUT_MANAGE_SECURITY,
    annotations: readAnnotations(),
    invoking: "Reading checkout session",
    invoked: "Checkout session loaded",
  },
  {
    name: "update_checkout",
    title: "Update Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description:
      "Use this to submit unchanged line items on an existing checkout session. Line changes are not supported. This does not move money.",
    idempotencyKeyRequired: false,
    resultResourceUri: UCP_MCP_CART_REVIEW_RESOURCE_URI,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        meta: UCP_META_SCHEMA,
        id: { type: "string", description: "Checkout session id." },
        checkout: checkoutResourceSchema,
      },
      required: ["id", "checkout"],
    },
    outputSchema: CHECKOUT_OUTPUT_SCHEMA,
    securitySchemes: CHECKOUT_MANAGE_SECURITY,
    annotations: writeAnnotations(),
    invoking: "Updating checkout session",
    invoked: "Checkout session updated",
  },
  {
    name: "complete_checkout",
    title: "Complete Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description:
      "Use this after the user asks to place the order to read checkout state and its trusted buyer continuation URL. This never creates orders or moves money.",
    idempotencyKeyRequired: true,
    resultResourceUri: UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        meta: UCP_META_SCHEMA,
        id: { type: "string", description: "Checkout session id." },
        checkout: checkoutResourceSchema,
      },
      required: ["id"],
    },
    outputSchema: CHECKOUT_OUTPUT_SCHEMA,
    securitySchemes: CHECKOUT_MANAGE_SECURITY,
    annotations: writeAnnotations({ destructive: true, openWorld: true }),
    invoking: "Preparing trusted checkout handoff",
    invoked: "Checkout handoff ready",
  },
  {
    name: "cancel_checkout",
    title: "Cancel Checkout",
    capability: UCP_CAPABILITIES.checkout,
    description:
      "Use this only when the user asks to cancel or abandon checkout. OAuth cancellation is a no-write read of checkout state; signed cancellation releases active reservations before order or payment commitment.",
    idempotencyKeyRequired: true,
    resultResourceUri: UCP_MCP_CART_REVIEW_RESOURCE_URI,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        meta: UCP_META_SCHEMA,
        id: { type: "string", description: "Checkout session id." },
      },
      required: ["id"],
    },
    outputSchema: CHECKOUT_OUTPUT_SCHEMA,
    securitySchemes: CHECKOUT_MANAGE_SECURITY,
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
        meta: UCP_META_SCHEMA,
        id: { type: "string", description: "Order id." },
      },
      required: ["id"],
    },
    outputSchema: ORDER_OUTPUT_SCHEMA,
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
  }> = {},
): UcpBusinessProfile {
  const baseUrl = normalizeUcpOrigin(origin);
  const signingKeys = options.signingKeys?.length ? options.signingKeys : undefined;
  return {
    ...(signingKeys ? { keys: signingKeys } : {}),
    ucp: {
      version: UCP_VERSION,
      payment_handlers: {},
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
          capability("catalog/search", "shopping/catalog_search.json", {
            scopes: { "catalog:read": "Read public catalog search results." },
          }),
        ],
        [UCP_CAPABILITIES.catalogLookup]: [
          capability("catalog/lookup", "shopping/catalog_lookup.json", {
            scopes: { "catalog:read": "Read public catalog product details." },
          }),
        ],
        [UCP_CAPABILITIES.checkout]: [
          capability("checkout", "shopping/checkout.json", {
            scopes: {
              "dev.ucp.shopping.checkout:manage": "Create, read, update, complete, and cancel checkout sessions.",
            },
          }),
        ],
        [UCP_CAPABILITIES.order]: [
          capability("order", "shopping/order.json", {
            scopes: { "dev.ucp.shopping.order:read": "Read linked buyer and seller orders." },
          }),
        ],
        [UCP_CAPABILITIES.identityLinking]: [
          capability("identity-linking", "common/identity_linking.json", {
            scopes: { "identity:link": "Link an agent to a buyer account." },
            oauth_authorization_server: `${baseUrl}/.well-known/oauth-authorization-server`,
          }),
        ],
      },
    },
  };
}

export function createUcpEnvelope<TPayload extends Readonly<Record<string, unknown>>>(
  status: UcpResponseStatus,
  payload: TPayload,
  messages: readonly UcpMessage[] = [],
): UcpEnvelope<TPayload> {
  const normalizedStatus = status;
  const normalizedMessages = messages.map((message) => ({
    type: "error" as const,
    severity: message.severity,
    code: message.code,
    content:
      message.content ??
      (typeof message.message === "string"
        ? message.message
        : (message.message as { message?: string } | undefined)?.message) ??
      message.code,
    ...((message.path ?? message.target) ? { path: message.path ?? message.target } : {}),
  }));
  const resourceKey = Object.keys(payload).find((key) => ["checkout", "order"].includes(key));
  const resource = resourceKey
    ? {
        ...(payload[resourceKey] as Readonly<Record<string, unknown>>),
        ...Object.fromEntries(Object.entries(payload).filter(([key]) => key !== resourceKey)),
      }
    : payload;
  return {
    ucp: {
      version: UCP_VERSION,
      status: normalizedStatus,
      ...(resourceKey === "checkout" && normalizedStatus === "success" ? { payment_handlers: {} } : {}),
    },
    ...(resource as TPayload),
    ...(normalizedStatus === "error"
      ? { messages: normalizedMessages }
      : normalizedMessages.length > 0
        ? { messages: normalizedMessages }
        : {}),
  };
}

export function unsupportedUcpOperation(operation: string): UcpEnvelope {
  return createUcpEnvelope("error", {}, [
    {
      severity: "recoverable",
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
