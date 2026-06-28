import { describe, expect, it } from "vitest";
import { isNativeMcpAnonymousDiscoveryRejected } from "./platform-smoke-native-mcp.mjs";

function responseWithStatus(status) {
  return { status };
}

describe("native MCP platform smoke", () => {
  it("accepts safe anonymous discovery rejection statuses", () => {
    expect(isNativeMcpAnonymousDiscoveryRejected(responseWithStatus(401))).toBe(true);
    expect(isNativeMcpAnonymousDiscoveryRejected(responseWithStatus(403))).toBe(true);
    expect(isNativeMcpAnonymousDiscoveryRejected(responseWithStatus(405))).toBe(true);
  });

  it("rejects success and missing-route responses", () => {
    expect(isNativeMcpAnonymousDiscoveryRejected(responseWithStatus(200))).toBe(false);
    expect(isNativeMcpAnonymousDiscoveryRejected(responseWithStatus(204))).toBe(false);
    expect(isNativeMcpAnonymousDiscoveryRejected(responseWithStatus(404))).toBe(false);
  });
});
