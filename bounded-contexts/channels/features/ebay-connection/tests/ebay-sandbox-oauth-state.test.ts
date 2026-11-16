import { describe, expect, it } from "vitest";
import {
  createOAuthState,
  hashOAuthState,
  scopesForCapabilities,
  parseIdentity,
  parseTokenResponse,
} from "../domain/oauth";

describe("ebay-sandbox-oauth-state", () => {
  it("uses independent 256-bit states and stores only their digest", () => {
    const states = Array.from({ length: 32 }, createOAuthState);
    expect(new Set(states).size).toBe(32);
    for (const state of states) {
      expect(Buffer.from(state, "base64url")).toHaveLength(32);
      expect(hashOAuthState(state)).toMatch(/^[a-f0-9]{64}$/);
      expect(hashOAuthState(state)).not.toContain(state);
    }
    for (const value of ["", "x", "a".repeat(44), "a".repeat(10000)]) expect(() => hashOAuthState(value)).toThrow();
  });
  it("requests only S1 scopes and adds publication only on explicit consent", () => {
    const initial = ["commerce.identity.readonly", "sell.account.readonly", "sell.inventory.readonly"].map(
      (scope) => `https://api.ebay.com/oauth/api_scope/${scope}`,
    );
    expect(scopesForCapabilities(false)).toEqual(initial);
    expect(scopesForCapabilities(true)).toEqual([...initial, "https://api.ebay.com/oauth/api_scope/sell.inventory"]);
  });
  it("closes getUser and discards every field except userId", () => {
    const value = {
      accountType: "INDIVIDUAL",
      registrationMarketplaceId: "EBAY_US",
      userId: "synthetic-subject",
      username: "synthetic-name",
    };
    expect(parseIdentity(value)).toBe(value.userId);
    for (const bad of [
      { ...value, extra: "x" },
      { ...value, username: 1 },
      { ...value, userId: "" },
      { ...value, userId: "x".repeat(1025) },
    ])
      expect(() => parseIdentity(bad)).toThrow("invalid-provider-response");
  });
  it("closes token shape and validates every lifetime before custody", () => {
    const value = {
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      expires_in: 7200,
      refresh_token_expires_in: 47304000,
      token_type: "User Access Token",
    };
    expect(parseTokenResponse(value, "2026-10-19T00:00:00Z")).toMatchObject({
      accessToken: value.access_token,
      accessExpiresAt: "2026-10-19T02:00:00.000Z",
    });
    for (const bad of [
      { ...value, extra: 1 },
      { ...value, expires_in: -1 },
      { ...value, expires_in: 0.5 },
      { ...value, refresh_token: null },
      { ...value, access_token: "x".repeat(16385) },
    ])
      expect(() => parseTokenResponse(bad, "2026-10-19T00:00:00Z")).toThrow("invalid-provider-response");
  });
});
