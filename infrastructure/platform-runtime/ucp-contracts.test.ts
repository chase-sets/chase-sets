import { describe, expect, it } from "vitest";
import {
  buildUcpBusinessProfile,
  createUcpEnvelope,
  UCP_CAPABILITIES,
  UCP_MCP_CART_REVIEW_RESOURCE_URI,
  UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
  UCP_MCP_ENDPOINT_PATH,
  UCP_MCP_MARKETPLACE_RESULTS_RESOURCE_URI,
  UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
  UCP_MCP_RESOURCES,
  UCP_MCP_TOOLS,
  UCP_REST_ENDPOINT_PATH,
  UCP_VERSION,
} from "./ucp";

describe("UCP contract profile", () => {
  it("advertises REST and MCP shopping services from the same origin", () => {
    const profile = buildUcpBusinessProfile("https://marketplace.example/");

    expect(profile.ucp.version).toBe(UCP_VERSION);
    expect(profile.ucp.services["dev.ucp.shopping"]).toEqual([
      expect.objectContaining({
        transport: "rest",
        endpoint: `https://marketplace.example${UCP_REST_ENDPOINT_PATH}`,
      }),
      expect.objectContaining({
        transport: "mcp",
        endpoint: `https://marketplace.example${UCP_MCP_ENDPOINT_PATH}`,
      }),
    ]);
    expect(profile.ucp).not.toHaveProperty("supported_versions");
  });

  it("declares the v1 capability set used by the profile", () => {
    const profile = buildUcpBusinessProfile("https://marketplace.example");

    expect(Object.keys(profile.ucp.capabilities).sort()).toEqual(
      [
        UCP_CAPABILITIES.catalogLookup,
        UCP_CAPABILITIES.catalogSearch,
        UCP_CAPABILITIES.checkout,
        UCP_CAPABILITIES.identityLinking,
        UCP_CAPABILITIES.order,
      ].sort(),
    );
    expect(profile.ucp.capabilities[UCP_CAPABILITIES.checkout]?.[0]).toMatchObject({
      config: { scopes: { "dev.ucp.shopping.checkout:manage": expect.any(String) } },
    });
  });

  it("advertises no AP2 capability", () => {
    const signingKey = { kty: "EC", crv: "P-256", kid: "merchant-current", x: "x", y: "y" };
    const profile = buildUcpBusinessProfile("https://marketplace.example", { signingKeys: [signingKey] });
    const serialized = JSON.stringify(profile);

    expect(Object.keys(UCP_CAPABILITIES)).not.toContain("ap2Mandate");
    expect(Object.keys(profile.ucp.capabilities)).not.toContain("dev.ucp.shopping.ap2_mandate");
    expect(serialized).not.toContain("shopping/ap2_mandate.json");
    expect(serialized).not.toContain("completion_requires_trusted_ui_without_ap2_mandate");
    expect(serialized.toLowerCase()).not.toContain("ap2");
    expect(profile.keys).toEqual([signingKey]);
    expect(profile).not.toHaveProperty("signing_keys");
    expect(profile.ucp).not.toHaveProperty("signing_keys");
  });
});

describe("UCP MCP tools", () => {
  it("keeps risky checkout completion and cancellation idempotency-keyed", () => {
    expect(UCP_MCP_TOOLS.filter((tool) => tool.idempotencyKeyRequired).map((tool) => tool.name)).toEqual([
      "complete_checkout",
      "cancel_checkout",
    ]);
  });

  it("declares ChatGPT Apps-compatible schemas, auth, and annotations", () => {
    const search = UCP_MCP_TOOLS.find((tool) => tool.name === "search_catalog");
    const createCheckout = UCP_MCP_TOOLS.find((tool) => tool.name === "create_checkout");
    const completeCheckout = UCP_MCP_TOOLS.find((tool) => tool.name === "complete_checkout");

    expect(search).toMatchObject({
      inputSchema: { type: "object" },
      outputSchema: { anyOf: expect.any(Array) },
      securitySchemes: [{ type: "noauth" }],
      annotations: { readOnlyHint: true },
    });
    expect(createCheckout).toMatchObject({
      securitySchemes: [{ type: "oauth2", scopes: ["dev.ucp.shopping.checkout:manage"] }],
      annotations: { readOnlyHint: false, destructiveHint: false },
    });
    expect(completeCheckout).toMatchObject({
      securitySchemes: [{ type: "oauth2", scopes: ["dev.ucp.shopping.checkout:manage"] }],
      annotations: { destructiveHint: true, openWorldHint: true },
    });
    // The retired unsigned MCP trusted-handoff bypass is intentionally absent;
    // complete/cancel dispatch is enforced by the composed checkout handlers.
    expect(completeCheckout).not.toHaveProperty("trustedHandoffOnUnsignedMcp");
    expect(UCP_MCP_TOOLS.find((tool) => tool.name === "get_product")?.outputSchema).toEqual({
      anyOf: [
        { $ref: "https://ucp.dev/2026-08-25/schemas/shopping/catalog_lookup.json#/$defs/get_product_response" },
        { $ref: "https://ucp.dev/2026-08-25/schemas/common/types/error_response.json" },
      ],
    });
  });

  it("validates UCP 2026-08-25 transport bytes and keeps catalog detail nested", () => {
    const success = createUcpEnvelope("success", { product: { id: "cat_1" } });
    expect(success).toEqual({ ucp: { version: UCP_VERSION, status: "success" }, product: { id: "cat_1" } });
    const failure = createUcpEnvelope("error", {}, [
      { severity: "recoverable", code: "validation_failed", message: "Checkout validation failed.", path: "id" },
    ]);
    expect(failure.messages).toEqual([
      {
        type: "error",
        severity: "recoverable",
        code: "validation_failed",
        content: "Checkout validation failed.",
        path: "id",
      },
    ]);
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("advertises MCP Apps resources for the agent commerce journey", () => {
    expect(UCP_MCP_RESOURCES).toEqual([
      expect.objectContaining({
        uri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
        mimeType: "text/html;profile=mcp-app",
      }),
      expect.objectContaining({
        uri: UCP_MCP_CART_REVIEW_RESOURCE_URI,
        mimeType: "text/html;profile=mcp-app",
      }),
      expect.objectContaining({
        uri: UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
        mimeType: "text/html;profile=mcp-app",
      }),
    ]);
    expect(
      UCP_MCP_TOOLS.filter(
        (tool) =>
          tool.capability === UCP_CAPABILITIES.catalogSearch || tool.capability === UCP_CAPABILITIES.catalogLookup,
      ).map((tool) => [tool.name, tool.resultResourceUri]),
    ).toEqual([
      ["search_catalog", UCP_MCP_PRODUCT_CARDS_RESOURCE_URI],
      ["lookup_catalog", UCP_MCP_PRODUCT_CARDS_RESOURCE_URI],
      ["get_product", UCP_MCP_PRODUCT_CARDS_RESOURCE_URI],
    ]);
    expect(
      UCP_MCP_TOOLS.filter((tool) => tool.capability === UCP_CAPABILITIES.checkout).map((tool) => [
        tool.name,
        tool.resultResourceUri,
      ]),
    ).toEqual([
      ["create_checkout", UCP_MCP_CART_REVIEW_RESOURCE_URI],
      ["get_checkout", UCP_MCP_CART_REVIEW_RESOURCE_URI],
      ["update_checkout", UCP_MCP_CART_REVIEW_RESOURCE_URI],
      ["complete_checkout", UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI],
      ["cancel_checkout", UCP_MCP_CART_REVIEW_RESOURCE_URI],
    ]);
    expect(UCP_MCP_MARKETPLACE_RESULTS_RESOURCE_URI).toBe(UCP_MCP_PRODUCT_CARDS_RESOURCE_URI);
  });
});

describe("UCP envelopes", () => {
  it("adds protocol metadata without changing payload fields", () => {
    expect(createUcpEnvelope("success", { products: [] })).toEqual({
      ucp: { version: UCP_VERSION, status: "success" },
      products: [],
    });
  });
});

describe("UCP 2026-08-25 contract", () => {
  it("publishes canonical profile fields and root resources", () => {
    const profile = buildUcpBusinessProfile("https://shop.example");
    expect(profile.ucp.version).toBe("2026-08-25");
    expect(profile.ucp.payment_handlers).toEqual({});
    expect(profile.ucp).not.toHaveProperty("supported_versions");
    expect(createUcpEnvelope("success", { checkout: { id: "chk_1" } })).toEqual({
      ucp: { version: "2026-08-25", status: "success", payment_handlers: {} },
      id: "chk_1",
    });
  });
});
