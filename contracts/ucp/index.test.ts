import { describe, expect, it } from "vitest";
import {
  buildUcpBusinessProfile,
  createUcpEnvelope,
  UCP_CAPABILITIES,
  UCP_MCP_ENDPOINT_PATH,
  UCP_MCP_TOOLS,
  UCP_REST_ENDPOINT_PATH,
  UCP_VERSION,
} from "./index";

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
    expect(profile.ucp.supported_versions[UCP_VERSION]).toBe(
      "https://marketplace.example/.well-known/ucp",
    );
  });

  it("declares the v1 capability set used by the profile", () => {
    const profile = buildUcpBusinessProfile("https://marketplace.example");

    expect(Object.keys(profile.ucp.capabilities).sort()).toEqual([
      UCP_CAPABILITIES.ap2Mandate,
      UCP_CAPABILITIES.catalogLookup,
      UCP_CAPABILITIES.catalogSearch,
      UCP_CAPABILITIES.checkout,
      UCP_CAPABILITIES.identityLinking,
      UCP_CAPABILITIES.order,
    ].sort());
    expect(profile.ucp.capabilities[UCP_CAPABILITIES.checkout]?.[0]?.config).toEqual({
      completion_requires_trusted_ui_without_ap2_mandate: true,
    });
  });
});

describe("UCP MCP tools", () => {
  it("keeps risky checkout completion and cancellation idempotency-keyed", () => {
    expect(
      UCP_MCP_TOOLS.filter((tool) => tool.idempotencyKeyRequired).map((tool) => tool.name),
    ).toEqual(["complete_checkout", "cancel_checkout"]);
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
