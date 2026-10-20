import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UCP_MCP_TOOLS, buildUcpBusinessProfile } from "./ucp-contracts";
import { compileUcpSchema, ucpSchemaValidator, unresolvedUcpRefs } from "./ucp-schema-test-support";
import { ucpToolInputSchema, ucpToolOutputSchema } from "./ucp-tool-schemas";

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

describe("UCP 2026-08-25 contract", () => {
  it("pinned UCP 2026-08-25 closure resolves offline", () => {
    const rootPath = fileURLToPath(new URL("./__fixtures__/ucp-2026-08-25/schemas/", import.meta.url));
    expect(fixtureFiles(rootPath)).toHaveLength(66);
    expect(unresolvedUcpRefs()).toEqual([]);
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

  it("UCP 2026-08-25 tool schemas validate", () => {
    for (const tool of UCP_MCP_TOOLS) {
      expect(compileUcpSchema(ucpToolInputSchema(tool.name))).toBeTypeOf("function");
      expect(compileUcpSchema(ucpToolOutputSchema(tool.name))).toBeTypeOf("function");
    }
    const search = compileUcpSchema(ucpToolInputSchema("search_catalog"));
    expect(search({ search_request: { query: "cards", pagination: { limit: 10, cursor: "next" } } })).toBe(true);
    expect(search({ search_request: { query: "cards" }, limit: 10 })).toBe(false);
    expect(search({ search_request: { query: "cards" }, cursor: "next" })).toBe(false);
    expect(
      compileUcpSchema(ucpToolInputSchema("lookup_catalog"))({
        lookup_request: { ids: ["product_1"] },
        meta: { "idempotency-key": "retry_1" },
      }),
    ).toBe(true);
    expect(compileUcpSchema(ucpToolInputSchema("get_product"))({ get_product_request: { id: "product_1" } })).toBe(
      true,
    );
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
        checkout: { line_items: minimalCheckout.line_items },
      }),
    ).toBe(true);
    expect(compileUcpSchema(ucpToolInputSchema("cancel_checkout"))({ id: "chk_1" })).toBe(true);
    expect(compileUcpSchema(ucpToolInputSchema("get_order"))({ id: "ord_1" })).toBe(true);
    for (const tool of [
      "create_checkout",
      "get_checkout",
      "update_checkout",
      "complete_checkout",
      "cancel_checkout",
    ] as const) {
      const validate = compileUcpSchema(ucpToolOutputSchema(tool));
      expect(validate(minimalCheckout), `${tool}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(validate({ checkout: minimalCheckout })).toBe(false);
      expect(validate({ action: "continue" })).toBe(false);
      expect(validate({ ...minimalCheckout, status: undefined })).toBe(false);
      expect(validate(errorResponse)).toBe(true);
      expect(validate({ ...errorResponse, messages: undefined })).toBe(false);
    }
    expect(compileUcpSchema(ucpToolOutputSchema("get_order"))(minimalCheckout)).toBe(false);
    expect(compileUcpSchema(ucpToolOutputSchema("get_product"))({ id: "product_1" })).toBe(false);
  });
});
