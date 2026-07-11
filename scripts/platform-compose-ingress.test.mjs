import { describe, expect, it } from "vitest";
import { shouldRouteToApi } from "./platform-compose-ingress.mjs";
import { platformApiIngressPrefixes } from "./render-platform-helm-values.mjs";

describe("platform-compose-ingress", () => {
  it("routes every real Helm ingress API prefix to platform-api, matching the rendered chart", () => {
    for (const prefix of platformApiIngressPrefixes) {
      expect(shouldRouteToApi(prefix)).toBe(true);
      expect(shouldRouteToApi(`${prefix}/nested/path`)).toBe(true);
    }
  });

  it("routes UCP, MCP, and well-known discovery paths to platform-api", () => {
    expect(shouldRouteToApi("/.well-known/ucp")).toBe(true);
    expect(shouldRouteToApi("/ucp/v1")).toBe(true);
    expect(shouldRouteToApi("/mcp")).toBe(true);
  });

  it("routes provider webhook paths to platform-api", () => {
    expect(shouldRouteToApi("/api/payments/provider/webhooks/stripe")).toBe(true);
    expect(shouldRouteToApi("/api/fulfillment/provider/postage/webhooks/easypost")).toBe(true);
  });

  it("falls through page routes to the web app", () => {
    expect(shouldRouteToApi("/")).toBe(false);
    expect(shouldRouteToApi("/search")).toBe(false);
    expect(shouldRouteToApi("/account")).toBe(false);
    expect(shouldRouteToApi("/sign-in")).toBe(false);
  });

  it("does not prefix-match unrelated paths that merely start with the same characters", () => {
    expect(shouldRouteToApi("/mcp-docs")).toBe(false);
    expect(shouldRouteToApi("/apiary")).toBe(false);
  });
});
