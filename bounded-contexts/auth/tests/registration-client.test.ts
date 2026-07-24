import { describe, expect, it, vi } from "vitest";
import { createAuthApiClient } from "../client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("canonical registration client", () => {
  it("resolves the authoritative bundle and submits its exact operation ID, order, and affirmation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          operationId: "cmd_registration_1",
          snapshot: {
            bundleKey: "registration",
            requirements: [
              { policyKey: "terms-of-service", version: "v2", href: "/terms" },
              { policyKey: "privacy-policy", version: "v4", href: "/privacy" },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session_1" }, 201));
    const client = createAuthApiClient({
      baseUrl: "https://api.test/api/auth",
      fetch,
    });

    await expect(
      client.registerWithAuthoritativeConsent<{ sessionToken: string }>(
        {
          email: "buyer@example.com",
          displayName: "Buyer",
          registrationConsent: { operationId: "caller-cannot-override" },
        },
        { affirmed: true },
      ),
    ).resolves.toEqual({ sessionToken: "session_1" });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.test/api/auth/registration-consent",
      expect.objectContaining({ credentials: "include" }),
    );
    const [, submitRequest] = fetch.mock.calls[1]!;
    expect(JSON.parse(String(submitRequest?.body))).toEqual({
      email: "buyer@example.com",
      displayName: "Buyer",
      registrationConsent: {
        operationId: "cmd_registration_1",
        snapshot: {
          bundleKey: "registration",
          requirements: [
            { policyKey: "terms-of-service", version: "v2", href: "/terms" },
            { policyKey: "privacy-policy", version: "v4", href: "/privacy" },
          ],
        },
        affirmed: true,
      },
    });
  });

  it("submits a false affirmation for an empty pre-activation bundle", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          operationId: "cmd_empty",
          snapshot: { bundleKey: "registration", requirements: [] },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session_empty" }, 201));
    const client = createAuthApiClient({
      baseUrl: "https://api.test/api/auth",
      fetch,
    });

    await client.registerWithAuthoritativeConsent({ email: "empty@example.com" }, { affirmed: false });

    const [, submitRequest] = fetch.mock.calls[1]!;
    expect(JSON.parse(String(submitRequest?.body)).registrationConsent).toEqual({
      operationId: "cmd_empty",
      snapshot: { bundleKey: "registration", requirements: [] },
      affirmed: false,
    });
  });

  it("fails closed before registration when an active bundle is not affirmed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      jsonResponse({
        operationId: "cmd_active",
        snapshot: {
          bundleKey: "registration",
          requirements: [{ policyKey: "terms-of-service", version: "v2", href: "/terms" }],
        },
      }),
    );
    const client = createAuthApiClient({
      baseUrl: "https://api.test/api/auth",
      fetch,
    });

    await expect(
      client.registerWithAuthoritativeConsent({ email: "no@example.com" }, { affirmed: false }),
    ).rejects.toThrow("Registration consent affirmation is required.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed authoritative resolutions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      jsonResponse({
        operationId: "cmd_invalid",
        snapshot: {
          bundleKey: "registration",
          requirements: [{ policyKey: "terms-of-service", version: "v2" }],
        },
      }),
    );
    const client = createAuthApiClient({
      baseUrl: "https://api.test/api/auth",
      fetch,
    });

    await expect(client.resolveRegistrationConsent()).rejects.toThrow("Registration consent resolution is invalid.");
  });
});
