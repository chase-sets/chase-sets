import { describe, expect, it } from "vitest";
import {
  admitsCredentialLifetime,
  credentialDueAt,
  ebayCredentialMaintenancePolicy,
} from "../domain/credential-maintenance";
import { parseTokenResponse, parseRefreshResponse } from "../domain/oauth";

const issuedAt = "2026-11-16T00:00:00.000Z";
const exchange = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  token_type: "User Access Token",
  expires_in: 7200,
  refresh_token_expires_in: 1000000,
};
describe("ebay-credential-lifetime-admission", () => {
  it("pins the controller tuple, not a provider limit", () => {
    const policy = ebayCredentialMaintenancePolicy;
    expect(policy.policyKey).toBe("channels.ebay-credential-maintenance");
    expect(policy.defaultValue).toEqual({
      sweepSeconds: 450,
      refreshLeadSeconds: 1800,
      retryBackoffSeconds: [60, 300, 1800, 7200, 21600],
      maxAttempts: 6,
    });
    expect(() => policy.decodeValue({ ...policy.defaultValue, sweepSeconds: 451 })).toThrow();
  });
  it.each([7200, 2251, 2250, 2249, 1])(
    "admits exchange and refresh lifetime %s using only this response",
    (expires_in) => {
      const initial = parseTokenResponse({ ...exchange, expires_in }, issuedAt);
      const refreshed = parseRefreshResponse(
        { access_token: "synthetic-next", expires_in, token_type: "User Access Token" },
        issuedAt,
        initial,
      );
      for (const tokens of [initial, refreshed]) expect(admitsCredentialLifetime(tokens)).toBe(expires_in > 2250);
      expect(refreshed.refresh).toEqual(initial.refresh);
    },
  );
  it("does not schedule stale admitted responses or use refresh expiry as lifetime", () => {
    const tokens = parseTokenResponse(exchange, issuedAt);
    expect(credentialDueAt(tokens, new Date(issuedAt))).toEqual(new Date("2026-11-16T01:30:00.000Z"));
    expect(credentialDueAt(tokens, new Date("2026-11-16T01:30:00.000Z"))).toBeNull();
    expect(admitsCredentialLifetime({ ...tokens, accessExpiresAt: null })).toBe(false);
  });
  it.each([0, -1, 1.5, Infinity, NaN, 315360001, "7200", null])("rejects malformed lifetime %s", (expires_in) => {
    expect(() => parseTokenResponse({ ...exchange, expires_in }, issuedAt)).toThrow("invalid-provider-response");
    expect(() =>
      parseRefreshResponse(
        { access_token: "a", expires_in, token_type: "User Access Token" },
        issuedAt,
        parseTokenResponse(exchange, issuedAt),
      ),
    ).toThrow("invalid-provider-response");
  });
  it("closes schemas, token text and instant bounds", () => {
    const tokens = parseTokenResponse(exchange, issuedAt);
    for (const value of [
      { ...exchange, unexpected: true },
      { ...exchange, access_token: "" },
      { ...exchange, access_token: "bad\n" },
      { ...exchange, access_token: "a".repeat(16385) },
    ])
      expect(() => parseTokenResponse(value, issuedAt)).toThrow();
    for (const at of ["invalid", "1969-01-01T00:00:00Z", "9999-12-31T23:59:59.999Z"])
      expect(() => parseTokenResponse(exchange, at)).toThrow();
    expect(() =>
      parseRefreshResponse(
        { access_token: "a", expires_in: 7200, token_type: "User Access Token", refresh_token: "new" },
        issuedAt,
        tokens,
      ),
    ).toThrow();
    expect(() =>
      parseRefreshResponse(
        { access_token: "a", expires_in: 7200, token_type: "User Access Token", error_description: "secret" },
        issuedAt,
        tokens,
      ),
    ).toThrow();
  });
});
