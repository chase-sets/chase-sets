import { UCP_MCP_TOOLS } from "./ucp-contracts";

type JsonSchema = Record<string, unknown>;

const BASE = "https://ucp.dev/2026-08-25/schemas/";
const searchRequest = `${BASE}shopping/catalog_search.json#/$defs/search_request`;
const lookupRequest = `${BASE}shopping/catalog_lookup.json#/$defs/lookup_request`;
const productRequest = `${BASE}shopping/catalog_lookup.json#/$defs/get_product_request`;

const meta = {
  type: "object",
  additionalProperties: false,
  properties: { "ucp-agent": { type: "object" }, "idempotency-key": { type: "string" } },
} as const;
const ref = (value: string): JsonSchema => ({ $ref: value });
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

// Output schemas stay self-contained and shallow: default MCP SDK clients compile them on tools/list and
// cannot resolve remote UCP refs. Full UCP 2026-08-25 conformance is proven by the pinned capture tests.
const stringField = { type: "string" } as const;
const arrayField = { type: "array" } as const;
const objectField = { type: "object" } as const;

const errorBranch: JsonSchema = {
  type: "object",
  required: ["ucp", "messages"],
  properties: {
    ucp: {
      type: "object",
      required: ["version", "status"],
      properties: { version: stringField, status: { const: "error" } },
    },
    messages: { type: "array", minItems: 1, items: objectField },
    continue_url: stringField,
  },
};

const resourceOrError = (fields: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  anyOf: [
    {
      type: "object",
      required: ["ucp", ...Object.keys(fields)],
      properties: {
        ucp: {
          type: "object",
          required: ["version"],
          properties: { version: stringField, status: { const: "success" } },
        },
        ...fields,
      },
    },
    errorBranch,
  ],
});

const catalogResults = resourceOrError({ products: arrayField });
const checkoutResult = resourceOrError({
  id: stringField,
  status: stringField,
  currency: stringField,
  line_items: arrayField,
  totals: arrayField,
  links: arrayField,
});

const outputSchemas: Record<string, JsonSchema> = {
  search_catalog: catalogResults,
  lookup_catalog: catalogResults,
  get_product: resourceOrError({ product: objectField }),
  create_checkout: checkoutResult,
  get_checkout: checkoutResult,
  update_checkout: checkoutResult,
  complete_checkout: checkoutResult,
  cancel_checkout: checkoutResult,
  get_order: resourceOrError({
    id: stringField,
    checkout_id: stringField,
    permalink_url: stringField,
    currency: stringField,
    line_items: arrayField,
    totals: arrayField,
    fulfillment: objectField,
  }),
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
