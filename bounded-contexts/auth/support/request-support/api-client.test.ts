import { describe, expect, it } from "vitest";
import { createAuthApiClient } from "../../client";

function createRecordingFetch() {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return { fetch, calls };
}

describe("auth api client authentication methods", () => {
  it("posts magic link and passkey flows to their bounded auth endpoints", async () => {
    const { fetch, calls } = createRecordingFetch();
    const api = createAuthApiClient({ baseUrl: "https://app.test/api/auth", fetch });

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
      },
      {
        url: "https://app.test/api/auth/magic-link/consume",
        body: { token: "magic_token" },
      },
      {
        url: "https://app.test/api/auth/passkeys/challenge",
        body: {
          purpose: "passkey-sign-in",
          email: "seller@example.com",
        },
      },
      {
        url: "https://app.test/api/auth/passkeys/register",
        body: { externalCredentialId: "credential-id" },
      },
      {
        url: "https://app.test/api/auth/passkeys/sign-in",
        body: { externalCredentialId: "credential-id" },
      },
    ]);
  });
});
