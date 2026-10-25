import { UCP_MCP_TOOLS } from "./ucp-contracts";

type JsonSchema = Record<string, unknown>;

const BASE = "https://ucp.dev/2026-08-25/schemas/";
const checkout = `${BASE}shopping/checkout.json`;
const order = `${BASE}shopping/order.json`;
const searchRequest = `${BASE}shopping/catalog_search.json#/$defs/search_request`;
const searchResponse = `${BASE}shopping/catalog_search.json#/$defs/search_response`;
const lookupRequest = `${BASE}shopping/catalog_lookup.json#/$defs/lookup_request`;
const lookupResponse = `${BASE}shopping/catalog_lookup.json#/$defs/lookup_response`;
const productRequest = `${BASE}shopping/catalog_lookup.json#/$defs/get_product_request`;
const productResponse = `${BASE}shopping/catalog_lookup.json#/$defs/get_product_response`;
const errorResponse = `${BASE}common/types/error_response.json`;

const meta = {
  type: "object",
  additionalProperties: false,
  properties: { "ucp-agent": { type: "object" }, "idempotency-key": { type: "string" } },
} as const;
const ref = (value: string): JsonSchema => ({ $ref: value });
const union = (...refs: string[]): JsonSchema => ({ anyOf: refs.map((value) => ref(value)) });
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties: { ...properties, meta },
  ...(required.length ? { required } : {}),
});

const checkoutRequest: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    line_items: ref(`${BASE}shopping/checkout.json#/properties/line_items`),
    buyer: ref(`${BASE}shopping/checkout.json#/properties/buyer`),
    context: ref(`${BASE}shopping/checkout.json#/properties/context`),
    signals: ref(`${BASE}shopping/checkout.json#/properties/signals`),
    attribution: ref(`${BASE}shopping/checkout.json#/properties/attribution`),
    payment: ref(`${BASE}shopping/checkout.json#/properties/payment`),
  },
  required: ["line_items"],
};

const completeCheckoutRequest: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    signals: ref(`${BASE}shopping/checkout.json#/properties/signals`),
    attribution: ref(`${BASE}shopping/checkout.json#/properties/attribution`),
    payment: ref(`${BASE}shopping/checkout.json#/properties/payment`),
  },
  required: ["payment"],
};

const inputSchemas: Record<string, JsonSchema> = {
  search_catalog: object({ catalog: ref(searchRequest) }, ["catalog"]),
  lookup_catalog: object({ catalog: ref(lookupRequest) }, ["catalog"]),
  get_product: object({ catalog: ref(productRequest) }, ["catalog"]),
  create_checkout: object({ checkout: checkoutRequest }, ["checkout"]),
  get_checkout: object({ id: { type: "string" } }, ["id"]),
  update_checkout: object({ id: { type: "string" }, checkout: checkoutRequest }, ["id", "checkout"]),
  complete_checkout: object({ id: { type: "string" }, checkout: completeCheckoutRequest }, ["id"]),
  cancel_checkout: object({ id: { type: "string" } }, ["id"]),
  get_order: object({ id: { type: "string" } }, ["id"]),
};

const outputSchemas: Record<string, JsonSchema> = {
  search_catalog: union(searchResponse, errorResponse),
  lookup_catalog: union(lookupResponse, errorResponse),
  get_product: union(productResponse, errorResponse),
  create_checkout: union(checkout, errorResponse),
  get_checkout: union(checkout, errorResponse),
  update_checkout: union(checkout, errorResponse),
  complete_checkout: union(checkout, errorResponse),
  cancel_checkout: union(checkout, errorResponse),
  get_order: union(order, errorResponse),
};

export function ucpToolInputSchema(tool: (typeof UCP_MCP_TOOLS)[number]["name"]): JsonSchema {
  const schema = inputSchemas[tool];
  if (!schema) throw new Error(`unknown UCP MCP tool: ${tool}`);
  return schema;
}

export function ucpToolOutputSchema(tool: (typeof UCP_MCP_TOOLS)[number]["name"]): JsonSchema {
  const schema = outputSchemas[tool];
  if (!schema) throw new Error(`unknown UCP MCP tool: ${tool}`);
  return schema;
}
