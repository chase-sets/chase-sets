import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import { UCP_MCP_TOOLS, buildUcpBusinessProfile } from "./ucp-contracts";
import { compileUcpSchema, ucpSchemaValidator, unresolvedUcpRefs } from "./ucp-schema-test-support";
import { ucpToolInputSchema, ucpToolOutputSchema } from "./ucp-tool-schemas";

type UcpToolName = (typeof UCP_MCP_TOOLS)[number]["name"];

const base = "https://ucp.dev/2026-08-25/schemas/";
const schema = (path: string) => `${base}${path}`;

function fixtureFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? fixtureFiles(path) : entry.name.endsWith(".json") ? [path] : [];
  });
}

const minimalCheckout = {
  ucp: { version: "2026-08-25", status: "success", payment_handlers: {} },
  id: "chk_1",
  line_items: [
    {
      id: "line_1",
      item: { id: "product_1", title: "Example card", price: 100 },
      quantity: 1,
      totals: [
        { type: "subtotal", amount: 100 },
        { type: "total", amount: 100 },
      ],
    },
  ],
  status: "ready_for_complete",
  currency: "USD",
  totals: [
    { type: "subtotal", amount: 100 },
    { type: "total", amount: 100 },
  ],
  links: [{ type: "terms_of_service", url: "https://shop.example/terms" }],
};

const errorResponse = {
  ucp: { version: "2026-08-25", status: "error" },
  messages: [{ type: "error", severity: "recoverable", code: "bad_request", content: "Bad request" }],
};

const minimalOrder = {
  ucp: { version: "2026-08-25", status: "success" },
  id: "ord_1",
  checkout_id: "chk_1",
  permalink_url: "https://shop.example/orders/ord_1",
  line_items: [
    {
      id: "line_1",
      item: { id: "product_1", title: "Example card", price: 100 },
      quantity: { original: 1, total: 1, fulfilled: 0 },
      totals: [
        { type: "subtotal", amount: 100 },
        { type: "total", amount: 100 },
      ],
      status: "processing",
    },
  ],
  fulfillment: {},
  currency: "USD",
  totals: [
    { type: "subtotal", amount: 100 },
    { type: "total", amount: 100 },
  ],
};

const malformedProduct = {
  ucp: { version: "2026-08-25", status: "success" },
  product: { id: "product_1", title: "Example card", price: 100 },
};

const checkoutTools = [
  "create_checkout",
  "get_checkout",
  "update_checkout",
  "complete_checkout",
  "cancel_checkout",
] as const satisfies readonly UcpToolName[];

const resourceFamilies: readonly Readonly<{
  tools: readonly UcpToolName[];
  sample: Readonly<Record<string, unknown>>;
  required: readonly string[];
}>[] = [
  {
    tools: ["search_catalog", "lookup_catalog"],
    sample: { ucp: { version: "2026-08-25", status: "success" }, products: [] },
    required: ["ucp", "products"],
  },
  {
    tools: ["get_product"],
    sample: { ucp: { version: "2026-08-25", status: "success" }, product: { id: "product_1" } },
    required: ["ucp", "product"],
  },
  {
    tools: checkoutTools,
    sample: minimalCheckout,
    required: ["ucp", "id", "status", "currency", "line_items", "totals", "links"],
  },
  {
    tools: ["get_order"],
    sample: minimalOrder,
    required: ["ucp", "id", "checkout_id", "permalink_url", "currency", "line_items", "totals", "fulfillment"],
  },
];

const sdkValidator = new AjvJsonSchemaValidator();
function advertised(tool: UcpToolName) {
  const validate = sdkValidator.getValidator(ucpToolOutputSchema(tool) as JsonSchemaType);
  return (value: unknown) => validate(value).valid;
}

function without(value: Readonly<Record<string, unknown>>, field: string) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

function mistyped(value: unknown) {
  return typeof value === "string" ? 1 : Array.isArray(value) ? {} : "mistyped";
}

describe("UCP 2026-08-25 contract", () => {
  it("pinned UCP 2026-08-25 closure resolves offline", () => {
    const rootPath = fileURLToPath(new URL("./__fixtures__/ucp-2026-08-25/schemas/", import.meta.url));
    expect(unresolvedUcpRefs()).toEqual([]);
    expect(fixtureFiles(rootPath)).toHaveLength(66);
    for (const ref of [
      schema("profile.json"),
      schema("profile.json#/$defs/business_schema"),
      schema("shopping/checkout.json"),
      schema("shopping/order.json"),
      schema("shopping/catalog_search.json#/$defs/search_request"),
      schema("shopping/catalog_lookup.json#/$defs/lookup_request"),
      schema("shopping/catalog_lookup.json#/$defs/get_product_request"),
      schema("common/types/error_response.json"),
    ])
      expect(ucpSchemaValidator(ref)).toBeTypeOf("function");
    const profile = buildUcpBusinessProfile("https://shop.example", {
      signingKeys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "current" }],
    });
    (profile.ucp as { payment_handlers?: unknown }).payment_handlers = {};
    const validateProfile = ucpSchemaValidator(schema("profile.json#/$defs/business_schema"));
    expect(validateProfile(profile), JSON.stringify(validateProfile.errors)).toBe(true);
    expect(validateProfile({})).toBe(false);
  });

  it("UCP 2026-08-25 tool input schemas validate", () => {
    for (const tool of UCP_MCP_TOOLS) {
      expect(compileUcpSchema(ucpToolInputSchema(tool.name))).toBeTypeOf("function");
    }
    const search = compileUcpSchema(ucpToolInputSchema("search_catalog"));
    expect(
      search({
        catalog: {
          query: "cards",
          context: { currency: "USD" },
          filters: { categories: ["trading-cards"] },
          pagination: { limit: 10, cursor: "next" },
        },
      }),
    ).toBe(true);
    expect(search({ catalog: { query: "cards" }, limit: 10 })).toBe(false);
    expect(search({ catalog: { query: "cards" }, cursor: "next" })).toBe(false);
    expect(
      compileUcpSchema(ucpToolInputSchema("lookup_catalog"))({
        catalog: { ids: ["product_1"], context: { currency: "USD" }, filters: { categories: ["trading-cards"] } },
        meta: { "idempotency-key": "retry_1" },
      }),
    ).toBe(true);
    expect(compileUcpSchema(ucpToolInputSchema("get_product"))({ catalog: { id: "product_1" } })).toBe(true);
    expect(
      compileUcpSchema(ucpToolInputSchema("create_checkout"))({ checkout: { line_items: minimalCheckout.line_items } }),
    ).toBe(true);
    expect(
      compileUcpSchema(ucpToolInputSchema("update_checkout"))({
        id: "chk_1",
        checkout: { line_items: minimalCheckout.line_items },
      }),
    ).toBe(true);
    expect(compileUcpSchema(ucpToolInputSchema("get_checkout"))({ id: "chk_1" })).toBe(true);
    expect(
      compileUcpSchema(ucpToolInputSchema("complete_checkout"))({
        id: "chk_1",
        checkout: { payment: { instruments: [] } },
      }),
    ).toBe(true);
    expect(compileUcpSchema(ucpToolInputSchema("cancel_checkout"))({ id: "chk_1" })).toBe(true);
    expect(compileUcpSchema(ucpToolInputSchema("get_order"))({ id: "ord_1" })).toBe(true);
  });

  it("pinned UCP 2026-08-25 response schemas keep full conformance", () => {
    const checkout = ucpSchemaValidator(schema("shopping/checkout.json"));
    const order = ucpSchemaValidator(schema("shopping/order.json"));
    const product = ucpSchemaValidator(schema("shopping/catalog_lookup.json#/$defs/get_product_response"));
    const error = ucpSchemaValidator(schema("common/types/error_response.json"));

    expect(checkout(minimalCheckout), JSON.stringify(checkout.errors)).toBe(true);
    expect(checkout({ checkout: minimalCheckout })).toBe(false);
    expect(checkout({ action: "continue" })).toBe(false);
    expect(checkout({ ...minimalCheckout, status: undefined })).toBe(false);
    expect(checkout(minimalOrder)).toBe(false);
    expect(order(minimalOrder), JSON.stringify(order.errors)).toBe(true);
    expect(order(minimalCheckout)).toBe(false);
    expect(error(errorResponse), JSON.stringify(error.errors)).toBe(true);
    expect(error({ ...errorResponse, messages: undefined })).toBe(false);
    expect(product(malformedProduct)).toBe(false);
  });

  it("advertised tool output schemas are self-contained shallow object unions", () => {
    expect(resourceFamilies.flatMap((family) => family.tools).sort()).toEqual(
      UCP_MCP_TOOLS.map((tool) => tool.name).sort(),
    );
    for (const tool of UCP_MCP_TOOLS) {
      const outputSchema = ucpToolOutputSchema(tool.name);
      expect(outputSchema).toMatchObject({ type: "object", anyOf: [expect.any(Object), expect.any(Object)] });
      expect(JSON.stringify(outputSchema)).not.toMatch(/"\$(ref|dynamicRef|defs|id)"/);
      const validate = advertised(tool.name);
      expect(validate(errorResponse), tool.name).toBe(true);
      expect(validate({ ...errorResponse, continue_url: "https://shop.example/recover" }), tool.name).toBe(true);
      for (const invalid of [
        "error",
        1,
        null,
        [errorResponse],
        without(errorResponse, "ucp"),
        without(errorResponse, "messages"),
        { ...errorResponse, messages: [] },
        { ...errorResponse, messages: ["bad_request"] },
        { ...errorResponse, continue_url: 1 },
        { ...errorResponse, ucp: { version: "2026-08-25" } },
        { ...errorResponse, ucp: { version: "2026-08-25", status: "success" } },
        { ...errorResponse, ucp: { status: "error" } },
        { ...errorResponse, ucp: { version: 20260825, status: "error" } },
      ])
        expect(validate(invalid), `${tool.name} accepted ${JSON.stringify(invalid)}`).toBe(false);
    }

    for (const family of resourceFamilies) {
      for (const tool of family.tools) {
        const validate = advertised(tool);
        expect(validate(family.sample), tool).toBe(true);
        expect(validate({ ...family.sample, ucp: { version: "2026-08-25" } }), tool).toBe(true);
        expect(validate({ ...family.sample, extension: { kept: true } }), tool).toBe(true);
        expect(validate({ ...family.sample, ucp: { version: "2026-08-25", status: "error" } }), tool).toBe(false);
        expect(validate({ ...family.sample, ucp: { status: "success" } }), tool).toBe(false);
        expect(validate({ ...family.sample, ucp: { version: 20260825, status: "success" } }), tool).toBe(false);
        for (const field of family.required) {
          expect(validate(without(family.sample, field)), `${tool} without ${field}`).toBe(false);
          expect(validate({ ...family.sample, [field]: mistyped(family.sample[field]) }), `${tool} ${field}`).toBe(
            false,
          );
        }
        for (const other of resourceFamilies) {
          if (!other.tools.includes(tool))
            expect(validate(other.sample), `${tool} accepted ${other.tools[0]}`).toBe(false);
        }
      }
    }

    // Nested UCP semantics are intentionally left to the pinned validators above.
    expect(advertised("get_product")(malformedProduct)).toBe(true);
  });
});
