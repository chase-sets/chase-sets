import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthApiError, createAuthApiClient } from "../../client";
import { PLATFORM_INTERNAL_AUTH_HEADER } from "@chase-sets/platform-runtime/http";
import {
  createAuthRequestApiClient,
  createInternalAuthRequestApiClient,
} from "./api-client";

function createRecordingFetch() {
  const calls: {
    url: string;
    body: unknown;
    headers: Record<string, string>;
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: Object.fromEntries(new Headers(init?.headers)),
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return { fetch, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NODE_ENV;
  delete process.env.PLATFORM_INTERNAL_AUTH_SECRET;
});

describe("auth api client authentication methods", () => {
  it("posts magic link and passkey flows to their bounded auth endpoints", async () => {
    const { fetch, calls } = createRecordingFetch();
    const api = createAuthApiClient({
      baseUrl: "https://app.test/api/auth",
      fetch,
    });

    await api.requestMagicLink({ email: "seller@example.com" });
    await api.consumeMagicLink({ token: "magic_token" });
    await api.createPasskeyChallenge({
      purpose: "passkey-sign-in",
      email: "seller@example.com",
    });
    await api.registerPasskey({ externalCredentialId: "credential-id" });
    await api.signInWithPasskey({ externalCredentialId: "credential-id" });

    expect(calls).toEqual([
      {
        url: "https://app.test/api/auth/magic-link/request",
        body: { email: "seller@example.com" },
        headers: { "content-type": "application/json" },
      },
      {
        url: "https://app.test/api/auth/magic-link/consume",
        body: { token: "magic_token" },
        headers: { "content-type": "application/json" },
      },
      {
        url: "https://app.test/api/auth/passkeys/challenge",
        body: {
          purpose: "passkey-sign-in",
          email: "seller@example.com",
        },
        headers: { "content-type": "application/json" },
      },
      {
        url: "https://app.test/api/auth/passkeys/register",
        body: { externalCredentialId: "credential-id" },
        headers: { "content-type": "application/json" },
      },
      {
        url: "https://app.test/api/auth/passkeys/sign-in",
        body: { externalCredentialId: "credential-id" },
        headers: { "content-type": "application/json" },
      },
    ]);
  });

  it("does not send internal capability headers on generic server request clients", async () => {
    process.env.PLATFORM_INTERNAL_AUTH_SECRET = "server-secret";
    const { fetch, calls } = createRecordingFetch();
    vi.stubGlobal("fetch", fetch);
    const request = new Request("https://app.test/checkout/start");
    const api = createAuthRequestApiClient(request);

    await api.startGuestCheckout({
      displayName: "Jane Smith",
      email: "jane@example.com",
    });

    expect(calls[0]).toMatchObject({
      url: "https://app.test/api/auth/guest-checkout/start",
      body: { displayName: "Jane Smith", email: "jane@example.com" },
      headers: {
        "content-type": "application/json",
      },
    });
    expect(calls[0].headers).not.toHaveProperty(PLATFORM_INTERNAL_AUTH_HEADER);
  });

  it("preserves internal capability headers on internal server request clients", async () => {
    process.env.PLATFORM_INTERNAL_AUTH_SECRET = "server-secret";
    const { fetch, calls } = createRecordingFetch();
    vi.stubGlobal("fetch", fetch);
    const request = new Request("https://app.test/checkout/payments/pay_1");
    const api = createInternalAuthRequestApiClient(request);

    await api.requestGuestCheckoutClaimLink({ paymentId: "pay_1" });

    expect(calls[0]).toMatchObject({
      url: "https://app.test/api/auth/guest-checkout/claim-link/request",
      body: { paymentId: "pay_1" },
      headers: {
        "content-type": "application/json",
        [PLATFORM_INTERNAL_AUTH_HEADER]: "server-secret",
      },
    });
  });

  it("requires an explicit internal secret for internal server request clients in production", () => {
    process.env.NODE_ENV = "production";

    expect(() =>
      createInternalAuthRequestApiClient(new Request("https://app.test/")),
    ).toThrow("PLATFORM_INTERNAL_AUTH_SECRET is required");
  });

  it("uses structured API error messages instead of object stringification", async () => {
    const api = createAuthApiClient({
      baseUrl: "https://app.test/api/auth",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "internal_error",
              message: "Internal server error.",
            },
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        ),
    });

    await expect(
      api.startGuestCheckout({
        displayName: "Jane Smith",
        email: "jane@example.com",
      }),
    ).rejects.toThrow(
      new AuthApiError(500, {
        error: {
          code: "internal_error",
          message: "Internal server error.",
        },
      }),
    );
  });
});
