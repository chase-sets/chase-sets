import { describe, expect, it } from "vitest";
import {
  isNativeMcpAnonymousDiscoveryAccepted,
  isNativeMcpPermissionBoundaryError,
  isNativeMcpProtectedResourceChallenge,
  readNativeMcpBearerResourceMetadataUrl,
  readNativeMcpToolStructuredContent,
} from "./platform-smoke-native-mcp.mjs";

function responseWithStatus(status, headers = {}) {
  const entries = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: {
      get: (key) => entries.get(key.toLowerCase()) ?? null,
    },
  };
}

describe("native MCP platform smoke", () => {
  it("accepts anonymous discovery success", () => {
    expect(isNativeMcpAnonymousDiscoveryAccepted(responseWithStatus(200))).toBe(true);
  });

  it("rejects unsuccessful anonymous discovery responses", () => {
    expect(isNativeMcpAnonymousDiscoveryAccepted(responseWithStatus(204))).toBe(false);
    expect(isNativeMcpAnonymousDiscoveryAccepted(responseWithStatus(401))).toBe(false);
    expect(isNativeMcpAnonymousDiscoveryAccepted(responseWithStatus(404))).toBe(false);
  });

  it("recognizes protected resource bearer challenges", () => {
    const response = responseWithStatus(401, {
      "WWW-Authenticate": 'Bearer resource_metadata="https://marketplace.example/.well-known/oauth-protected-resource"',
    });

    expect(isNativeMcpProtectedResourceChallenge(response)).toBe(true);
    expect(readNativeMcpBearerResourceMetadataUrl(response)).toBe(
      "https://marketplace.example/.well-known/oauth-protected-resource",
    );
    expect(isNativeMcpProtectedResourceChallenge(responseWithStatus(401))).toBe(false);
    expect(isNativeMcpProtectedResourceChallenge(responseWithStatus(200))).toBe(false);
  });

  it("recognizes the authenticated inventory permission boundary", () => {
    expect(
      isNativeMcpPermissionBoundaryError({ message: "Missing required permission: inventory.view." }, "inventory.view"),
    ).toBe(true);
    expect(
      isNativeMcpPermissionBoundaryError({ message: "Missing required permission: inventory.edit." }, "inventory.view"),
    ).toBe(false);
    expect(isNativeMcpPermissionBoundaryError({ message: "Method not found." }, "inventory.view")).toBe(false);
  });

  it("reads native MCP tool structuredContent with a text JSON fallback", () => {
    expect(
      readNativeMcpToolStructuredContent({
        structuredContent: { items: [{ sourceKey: "tcgplayer-csv" }] },
        content: [{ type: "text", text: '{"items":[]}' }],
      }),
    ).toEqual({ items: [{ sourceKey: "tcgplayer-csv" }] });
    expect(
      readNativeMcpToolStructuredContent({
        content: [{ type: "text", text: '{"items":[{"sourceKey":"tcgplayer-csv"}]}' }],
      }),
    ).toEqual({ items: [{ sourceKey: "tcgplayer-csv" }] });
    expect(readNativeMcpToolStructuredContent({ content: [{ type: "json", json: { items: [] } }] })).toBeNull();
  });
});
