import { describe, expect, it, vi } from "vitest";
import {
  createFacebookSocialLoginProvider,
  createGoogleSocialLoginProvider,
} from "./providers";

describe("social login providers", () => {
  it("builds a Google authorization URL with state and callback", () => {
    const provider = createGoogleSocialLoginProvider({
      clientId: "google-client",
      clientSecret: "google-secret",
    });

    const url = new URL(provider.createAuthorizationUrl({
      state: "state-token",
      redirectUri: "https://market.test/api/auth/social/google/callback",
    }));

    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("google-client");
    expect(url.searchParams.get("state")).toBe("state-token");
    expect(url.searchParams.get("scope")).toContain("email");
  });

  it("normalizes Google userinfo into a verified social login profile", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("token")) {
        return Response.json({ access_token: "access-token" });
      }

      return Response.json({
        sub: "google-subject",
        email: "buyer@example.com",
        email_verified: true,
        name: "Buyer Example",
      });
    });
    const provider = createGoogleSocialLoginProvider({
      clientId: "google-client",
      clientSecret: "google-secret",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(provider.exchangeCallback({
      code: "code",
      redirectUri: "https://market.test/api/auth/social/google/callback",
    })).resolves.toMatchObject({
      providerName: "google",
      providerSubject: "google-subject",
      email: "buyer@example.com",
      emailVerified: true,
      displayName: "Buyer Example",
    });
  });

  it("normalizes Facebook profile responses", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("oauth/access_token")) {
        return Response.json({ access_token: "access-token" });
      }

      return Response.json({
        id: "facebook-subject",
        email: "seller@example.com",
        name: "Seller Example",
      });
    });
    const provider = createFacebookSocialLoginProvider({
      clientId: "facebook-client",
      clientSecret: "facebook-secret",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(provider.exchangeCallback({
      code: "code",
      redirectUri: "https://market.test/api/auth/social/facebook/callback",
    })).resolves.toMatchObject({
      providerName: "facebook",
      providerSubject: "facebook-subject",
      email: "seller@example.com",
      emailVerified: true,
      displayName: "Seller Example",
    });
  });
});
