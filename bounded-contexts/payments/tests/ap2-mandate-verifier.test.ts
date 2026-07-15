import { describe, expect, it, vi } from "vitest";
import { createRemoteUcpAp2MandateVerifier } from "../support/ucp-support/ap2-mandate-verifier";

const input = {
  checkout: { id: "chk_1", ap2: { merchant_authorization: "merchant.jws" } },
  checkoutMandate: { id: "ap2_checkout", token: "checkout-mandate-token" },
  paymentTokenPresent: true,
  verifiedAt: "2026-07-14T12:00:00.000Z",
} as const;

describe("remote AP2 mandate verifier", () => {
  it("requests direct-mode verification without disclosing the shared payment token", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        schema_version: "chase-sets-ucp-ap2-verification/v1",
        ucp_version: "2026-04-08",
        accepted_modes: ["human-present"],
        checkout_mandate: "checkout-mandate-token",
        payment_token_present: true,
      });
      expect(JSON.stringify(body)).not.toContain("spt_");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer verifier-secret" });
      return new Response(
        JSON.stringify({
          valid: true,
          mode: "human-present",
          verification_id: "verify_123",
          mandate_vct: "mandate.checkout.1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const verifier = createRemoteUcpAp2MandateVerifier({
      endpoint: "https://ap2-verifier.example/verify",
      authorizationToken: "verifier-secret",
      timeoutMs: 2_000,
      fetchImpl,
    });

    await expect(verifier.verify(input)).resolves.toEqual({
      ok: true,
      mode: "human-present",
      evidence: {
        verificationId: "verify_123",
        mandateVct: "mandate.checkout.1",
        verifier: "ap2-verifier.example",
        verifiedAt: "2026-07-14T12:00:00.000Z",
      },
    });
  });

  it("preserves verifier rejection codes", async () => {
    const verifier = createRemoteUcpAp2MandateVerifier({
      endpoint: "https://ap2-verifier.example/verify",
      authorizationToken: "verifier-secret",
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ valid: false, code: "mandate_expired", message: "Mandate expired." }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    });

    await expect(verifier.verify(input)).resolves.toEqual({
      ok: false,
      code: "mandate_expired",
      message: "The AP2 mandate has expired.",
    });
  });

  it("fails closed when the verifier is unavailable or returns an invalid response", async () => {
    const unavailable = createRemoteUcpAp2MandateVerifier({
      endpoint: "https://ap2-verifier.example/verify",
      authorizationToken: "verifier-secret",
      fetchImpl: vi.fn(async () => new Response("upstream failed", { status: 503 })),
    });
    const malformed = createRemoteUcpAp2MandateVerifier({
      endpoint: "https://ap2-verifier.example/verify",
      authorizationToken: "verifier-secret",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ valid: true }), { status: 200 })),
    });

    await expect(unavailable.verify(input)).resolves.toMatchObject({
      ok: false,
      code: "mandate_verification_unavailable",
    });
    await expect(malformed.verify(input)).resolves.toMatchObject({
      ok: false,
      code: "mandate_verification_unavailable",
    });
  });
});
