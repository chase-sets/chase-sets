import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createGoogleMerchantServiceAccountAccessTokenProvider,
  createServiceAccountJwt,
} from "../src/google-merchant-auth";

type TestFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("google merchant service account auth", () => {
  it("builds service account JWTs with the Merchant API content scope", () => {
    const jwt = createServiceAccountJwt({
      clientEmail: "merchant-sync@test-project.iam.gserviceaccount.com",
      privateKey: privateKeyPem,
      scope: "https://www.googleapis.com/auth/content",
      tokenUri: "https://oauth2.googleapis.com/token",
      now: () => Date.parse("2026-06-03T12:00:00.000Z"),
    });
    const [encodedHeader, encodedClaimSet, signature] = jwt.split(".");

    expect(JSON.parse(Buffer.from(encodedHeader!, "base64url").toString("utf8"))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(encodedClaimSet!, "base64url").toString("utf8"))).toMatchObject({
      iss: "merchant-sync@test-project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/content",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1780488000,
      exp: 1780491600,
    });
    expect(signature).toBeTruthy();
  });

  it("exchanges service account JSON for an access token and caches it", async () => {
    let now = Date.parse("2026-06-03T12:00:00.000Z");
    const fetchMock = vi.fn<TestFetch>(async (_url, init) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      expect(form.get("assertion")).toContain(".");
      return jsonResponse(200, {
        access_token: "ya29.cached-token",
        expires_in: 3600,
      });
    });
    const provider = createGoogleMerchantServiceAccountAccessTokenProvider({
      credentialSecretName: "GOOGLE_MERCHANT_SERVICE_ACCOUNT_JSON",
      fetch: fetchMock,
      now: () => now,
      secretResolver: () =>
        JSON.stringify({
          client_email: "merchant-sync@test-project.iam.gserviceaccount.com",
          private_key: privateKeyPem,
          token_uri: "https://oauth2.googleapis.com/token",
        }),
    });

    await expect(provider()).resolves.toBe("ya29.cached-token");
    now += 30 * 60 * 1000;
    await expect(provider()).resolves.toBe("ya29.cached-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails without exposing the configured secret name when the secret is missing", async () => {
    const provider = createGoogleMerchantServiceAccountAccessTokenProvider({
      credentialSecretName: "GOOGLE_MERCHANT_SERVICE_ACCOUNT_JSON",
      secretResolver: () => null,
    });

    await expect(provider()).rejects.toThrow("Google Merchant credential secret is not available.");
    await expect(provider()).rejects.not.toThrow("GOOGLE_MERCHANT_SERVICE_ACCOUNT_JSON");
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
