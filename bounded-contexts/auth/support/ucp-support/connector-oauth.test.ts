import { timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_OAUTH_SCOPE_FAMILIES,
  AGENT_OAUTH_SUPPORTED_SCOPES,
  CHANNEL_CONNECTOR_SCOPE_FAMILY,
  agentOAuthScopesForPermissions,
  isAgentOAuthScope,
  isChannelConnectorScope,
  normalizeAgentOAuthScopes,
  resolveAgentOAuthScopedPermissions,
} from "@chase-sets/auth-context";
import { compareConnectorSecret, connectorRecord, connectorSecretDigest, connectorString } from "./connector-oauth";
import { UCP_OAUTH_SCOPE_FAMILIES, UCP_OAUTH_SUPPORTED_SCOPES, resolveUcpScopedPermissions } from "./oauth";
import { resolveAuthSecurityLifetimesMs } from "../../features/sessions/domain/auth-flow";
import { MCP_OAUTH_DEFAULT_SCOPES_SUPPORTED } from "@chase-sets/platform-runtime/mcp";
import { flattenMcpTools, mcpServiceCatalog } from "@chase-sets/platform-runtime/mcp-contracts";
import * as authServer from "@chase-sets/auth/server";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, timingSafeEqual: vi.fn(original.timingSafeEqual) };
});

describe("connector-scope-family-isolation", () => {
  it.each(CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes)(
    "%s has no agent permission, family or grant advertisement",
    (scope) => {
      expect(isChannelConnectorScope(scope)).toBe(true);
      expect(isAgentOAuthScope(scope)).toBe(false);
      expect(normalizeAgentOAuthScopes([scope])).toEqual([]);
      expect(AGENT_OAUTH_SUPPORTED_SCOPES).not.toContain(scope);
      expect(UCP_OAUTH_SUPPORTED_SCOPES).not.toContain(scope);
      expect(authServer.UCP_OAUTH_SUPPORTED_SCOPES).not.toContain(scope);
      expect(MCP_OAUTH_DEFAULT_SCOPES_SUPPORTED).not.toContain(scope);
      expect(JSON.stringify(flattenMcpTools(mcpServiceCatalog))).not.toContain(scope);
      const permissions = [
        ...new Set(
          AGENT_OAUTH_SCOPE_FAMILIES.flatMap((family) =>
            family.scopes.flatMap((definition) => [...definition.permissions]),
          ),
        ),
      ];
      expect(resolveAgentOAuthScopedPermissions([scope], [...permissions, "channels.manage"])).toEqual([]);
      expect(resolveUcpScopedPermissions([scope], permissions)).toEqual([]);
      expect(authServer.resolveUcpScopedPermissions([scope], permissions)).toEqual([]);
      expect(agentOAuthScopesForPermissions(permissions)).not.toContain(scope);
      expect(JSON.stringify(UCP_OAUTH_SCOPE_FAMILIES)).not.toContain(scope);
    },
  );
  it("uses the existing validated default and override lifetime machinery", () => {
    expect(resolveAuthSecurityLifetimesMs().ucpAccessTokenTtlMs).toBe(3_600_000);
    expect(resolveAuthSecurityLifetimesMs({ ucpAccessTokenTtlMs: 600_000 }).ucpAccessTokenTtlMs).toBe(600_000);
    for (const value of [0, -1, NaN, Infinity, 999_999_999])
      expect(() => resolveAuthSecurityLifetimesMs({ ucpAccessTokenTtlMs: value })).toThrow();
  });
});
describe("connector-secret-comparison", () => {
  it("compares fixed-size digests and rejects changed, missing and malformed secrets", () => {
    vi.mocked(timingSafeEqual).mockClear();
    const secret = "credential-sentinel-secret";
    const digest = connectorSecretDigest(secret);
    expect(compareConnectorSecret(secret, digest)).toBe(true);
    expect(compareConnectorSecret(secret + "x", digest)).toBe(false);
    expect(compareConnectorSecret("", digest)).toBe(false);
    expect(compareConnectorSecret(secret, "invalid")).toBe(false);
    expect(digest).not.toContain(secret);
    expect(timingSafeEqual).toHaveBeenCalledTimes(4);
    for (const [actual, expected] of vi.mocked(timingSafeEqual).mock.calls) {
      expect(actual.byteLength).toBe(32);
      expect(expected.byteLength).toBe(32);
    }
  });
  it("refuses unknown object members and unbounded/wrong-type credential inputs", () => {
    for (const value of [null, [], "x", { code: "x", unknown: { secret: "sentinel" } }])
      expect(() => connectorRecord(value, ["code"])).toThrow();
    for (const value of [null, {}, 5, "", "x".repeat(513), "x\ny"]) expect(() => connectorString(value)).toThrow();
  });
});
