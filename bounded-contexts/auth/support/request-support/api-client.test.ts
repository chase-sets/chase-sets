import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthApiError, createAuthApiClient } from "../../client";
import { CHASE_SETS_INTERNAL_API_ORIGIN_ENV, PLATFORM_INTERNAL_AUTH_HEADER } from "@chase-sets/platform-runtime/http";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  appendFreshWriteToken,
  decodeFreshWriteReceipt,
  encodeCommitReceipt,
  getMutationResultCommandReceipt,
} from "@chase-sets/http/responses";
import { createAuthRequestApiClient, createInternalAuthRequestApiClient } from "./api-client";

const authSource = {
  sourceContextName: "auth",
  maxGlobalPosition: "42",
  eventIds: ["evt_auth"],
};

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
  delete process.env[CHASE_SETS_INTERNAL_API_ORIGIN_ENV];
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
    await api.exitGuestCheckout();
    await api.claimGuestCheckoutWithClaimContinuation({
      paymentId: "pay_1",
      continuation: "continuation_token",
    });
    await api.createPasskeyChallenge({
      purpose: "passkey-sign-in",
      email: "seller@example.com",
    });
    await api.registerPasskey({ externalCredentialId: "credential-id", webauthnResponse: "webauthn-response" });
    await api.signInWithPasskey({ externalCredentialId: "credential-id", webauthnResponse: "webauthn-response" });

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
        url: "https://app.test/api/auth/guest-checkout/exit",
        body: {},
        headers: { "content-type": "application/json" },
      },
      {
        url: "https://app.test/api/auth/guest-checkout/claim-with-continuation",
        body: {
          paymentId: "pay_1",
          continuation: "continuation_token",
        },
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
        body: { externalCredentialId: "credential-id", webauthnResponse: "webauthn-response" },
        headers: { "content-type": "application/json" },
      },
      {
        url: "https://app.test/api/auth/passkeys/sign-in",
        body: { externalCredentialId: "credential-id", webauthnResponse: "webauthn-response" },
        headers: { "content-type": "application/json" },
      },
    ]);
  });

  it("does not send internal capability headers on generic server request clients", async () => {
    process.env.PLATFORM_INTERNAL_AUTH_SECRET = "server-secret";
    process.env[CHASE_SETS_INTERNAL_API_ORIGIN_ENV] = "https://app.test";
    const { fetch, calls } = createRecordingFetch();
    vi.stubGlobal("fetch", fetch);
    const request = new Request("https://app.test/checkout/start");
    const api = createAuthRequestApiClient(request);

    await api.bindGuestCheckoutContact({
      displayName: "Jane Smith",
      email: "jane@example.com",
    });

    expect(calls[0]).toMatchObject({
      url: "https://app.test/api/auth/guest-checkout/contact",
      body: { displayName: "Jane Smith", email: "jane@example.com" },
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": "app.test",
        "x-forwarded-proto": "https",
      },
    });
    expect(calls[0].headers).not.toHaveProperty(PLATFORM_INTERNAL_AUTH_HEADER);
  });

  it("sends internal capability header for Guest Contact bind", async () => {
    process.env.PLATFORM_INTERNAL_AUTH_SECRET = "server-secret";
    process.env[CHASE_SETS_INTERNAL_API_ORIGIN_ENV] = "https://app.test";
    const { fetch, calls } = createRecordingFetch();
    vi.stubGlobal("fetch", fetch);
    const request = new Request("https://app.test/checkout/payments/pay_1");
    const api = createInternalAuthRequestApiClient(request);

    await api.bindGuestCheckoutContact({ email: "buyer@example.com", displayName: "Buyer Example" });

    expect(calls[0]).toMatchObject({
      url: "https://app.test/api/auth/guest-checkout/contact",
      body: { email: "buyer@example.com", displayName: "Buyer Example" },
      headers: {
        "content-type": "application/json",
        [PLATFORM_INTERNAL_AUTH_HEADER]: "server-secret",
        "x-forwarded-host": "app.test",
        "x-forwarded-proto": "https",
      },
    });
  });

  it("requires an explicit internal secret for internal server request clients in production", () => {
    process.env.NODE_ENV = "production";

    expect(() => createInternalAuthRequestApiClient(new Request("https://app.test/"))).toThrow(
      "PLATFORM_INTERNAL_AUTH_SECRET is required",
    );
  });

  it("keeps command receipts on Auth mutation responses without exposing them in JSON", async () => {
    const api = createAuthApiClient({
      baseUrl: "https://app.test/api/auth",
      fetch: async () =>
        new Response(JSON.stringify({ id: "ses_1", version: 3, status: "revoked" }), {
          headers: {
            "Content-Type": "application/json",
            "Chase-Sets-Consistency": "eventual",
            [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([authSource]),
          },
        }),
    });

    const result = await api.revokeSession<{ id: string; version: number; status: string }>("ses_1");

    expect(result).toEqual({ id: "ses_1", version: 3, status: "revoked" });
    expect(Object.keys(result).sort()).toEqual(["id", "status", "version"]);
    expect(JSON.stringify(result)).toBe('{"id":"ses_1","version":3,"status":"revoked"}');
    expect(getMutationResultCommandReceipt(result)).toEqual({
      mode: "eventual",
      commitEventIds: [],
      commitPositions: [authSource],
    });
  });

  it("forwards fresh-read receipts and target context on Auth API reads", async () => {
    const request = new Request(
      `http://localhost${appendFreshWriteToken(
        "/account/sessions/ses_1",
        { commitPositions: [authSource], commitEventIds: ["evt_auth"] },
        Date.now(),
      )}`,
      {
        headers: {
          cookie: "chase_sets_session=session_token",
        },
      },
    );
    let receivedInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedInit = init;
      return new Response(JSON.stringify({ id: "ses_1", status: "revoked" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    await createAuthRequestApiClient(request).getSession("ses_1");

    const headers = new Headers(receivedInit?.headers);
    expect(headers.get("cookie")).toBe("chase_sets_session=session_token");
    expect(decodeFreshWriteReceipt(headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER))).toMatchObject({
      sources: [authSource],
    });
    expect(headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("auth");
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
