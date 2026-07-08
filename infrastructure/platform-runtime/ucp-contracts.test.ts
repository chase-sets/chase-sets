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
    expect(profile.ucp.supported_versions[UCP_VERSION]).toBe("https://marketplace.example/.well-known/ucp");
  });

  it("declares the v1 capability set used by the profile", () => {
    const profile = buildUcpBusinessProfile("https://marketplace.example");

    expect(Object.keys(profile.ucp.capabilities).sort()).toEqual(
      [
        UCP_CAPABILITIES.ap2Mandate,
        UCP_CAPABILITIES.catalogLookup,
        UCP_CAPABILITIES.catalogSearch,
        UCP_CAPABILITIES.checkout,
        UCP_CAPABILITIES.identityLinking,
        UCP_CAPABILITIES.order,
      ].sort(),
    );
    expect(profile.ucp.capabilities[UCP_CAPABILITIES.checkout]?.[0]?.config).toEqual({
      completion_requires_trusted_ui_without_ap2_mandate: true,
    });
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
      outputSchema: { type: "object" },
      securitySchemes: [{ type: "noauth" }],
      annotations: { readOnlyHint: true },
    });
    expect(createCheckout).toMatchObject({
      securitySchemes: [{ type: "oauth2", scopes: ["checkout:write"] }],
      annotations: { readOnlyHint: false, destructiveHint: false },
    });
    expect(completeCheckout).toMatchObject({
      trustedHandoffOnUnsignedMcp: true,
      securitySchemes: [{ type: "oauth2", scopes: ["checkout:write"] }],
      annotations: { destructiveHint: true, openWorldHint: true },
    });
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
    expect(createUcpEnvelope("ok", { products: [] })).toEqual({
      ucp: { version: UCP_VERSION, status: "ok" },
      products: [],
    });
  });
});
