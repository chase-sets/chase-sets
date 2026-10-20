import type { AnySchema } from "ajv/dist/2020";
import { UCP_MCP_TOOLS } from "./ucp-contracts";

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
const ref = (value: string): AnySchema => ({ $ref: value });
const union = (...refs: string[]): AnySchema => ({ anyOf: refs.map((value) => ref(value)) });
const object = (properties: Record<string, AnySchema>, required: string[] = []): AnySchema => ({
  type: "object",
  additionalProperties: false,
  properties: { ...properties, meta },
  ...(required.length ? { required } : {}),
});

const checkoutRequest: AnySchema = {
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

const inputSchemas: Record<string, AnySchema> = {
  search_catalog: object({ search_request: ref(searchRequest) }, ["search_request"]),
  lookup_catalog: object({ lookup_request: ref(lookupRequest) }, ["lookup_request"]),
  get_product: object({ get_product_request: ref(productRequest) }, ["get_product_request"]),
  create_checkout: object({ checkout: checkoutRequest }, ["checkout"]),
  get_checkout: object({ id: { type: "string" } }, ["id"]),
  update_checkout: object({ id: { type: "string" }, checkout: checkoutRequest }, ["id", "checkout"]),
  complete_checkout: object({ id: { type: "string" }, checkout: checkoutRequest }, ["id"]),
  cancel_checkout: object({ id: { type: "string" } }, ["id"]),
  get_order: object({ id: { type: "string" } }, ["id"]),
};

const outputSchemas: Record<string, AnySchema> = {
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

export function ucpToolInputSchema(tool: (typeof UCP_MCP_TOOLS)[number]["name"]): AnySchema {
  const schema = inputSchemas[tool];
  if (!schema) throw new Error(`unknown UCP MCP tool: ${tool}`);
  return schema;
}

export function ucpToolOutputSchema(tool: (typeof UCP_MCP_TOOLS)[number]["name"]): AnySchema {
  const schema = outputSchemas[tool];
  if (!schema) throw new Error(`unknown UCP MCP tool: ${tool}`);
  return schema;
}
