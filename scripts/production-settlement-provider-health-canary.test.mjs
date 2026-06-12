import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  parseProductionSettlementProviderHealthCanaryArgs,
  runProductionSettlementProviderHealthCanary,
  validateProductionSettlementProviderHealthCanaryOptions,
} from "./production-settlement-provider-health-canary.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("production settlement provider-health canary", () => {
  it("signs in with the proof operator and records provider-health evidence", async () => {
    const calls = [];
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-settlement-provider-health-canary-"));
    const outPath = join(directory, "settlement-provider-health.json");

    const evidence = await runProductionSettlementProviderHealthCanary(
      {
        outPath,
        baseUrl: "https://marketplace.chasesets.com",
        authBaseUrl: "https://marketplace.chasesets.com",
        email: "ops@example.test",
        password: "secret-password",
        accountId: "acc_ops",
        environment: "production-proof",
        productionProofReference: "PRODUCTION-PROOF-2026-06-12",
        checkedAt: "2026-06-12T12:00:00.000Z",
      },
      async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const path = new URL(String(url)).pathname;
        if (path === "/api/auth/password-sign-in") {
          expect(JSON.parse(init.body)).toMatchObject({
            email: "ops@example.test",
            password: "secret-password",
            accountId: "acc_ops",
          });
          return jsonResponse({ sessionToken: "session_operator" });
        }
        if (path === "/api/settlement/provider-health") {
          expect(init.headers.Authorization).toBe("Bearer session_operator");
          return jsonResponse({
            provider_name: "stripe",
            adapter_mode: "provider",
            webhook_signature_required: true,
            platform_balance_supported: true,
            connected_account_payouts_supported: true,
          });
        }
        return jsonResponse({ error: "unexpected" }, 404);
      },
    );

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/auth/password-sign-in",
      "/api/settlement/provider-health",
    ]);
    expect(evidence).toMatchObject({
      schemaVersion: "production-settlement-provider-health-canary/v1",
      status: "pass",
      providerName: "stripe",
      adapterMode: "provider",
      baseOrigin: "https://marketplace.chasesets.com",
    });
    expect(JSON.stringify(evidence)).not.toContain("secret-password");
    expect(JSON.stringify(evidence)).not.toContain("session_operator");
    expect(JSON.parse(await readFile(outPath, "utf8"))).toEqual(evidence);
  });

  it("fails closed without production-proof credentials and reference", () => {
    expect(
      validateProductionSettlementProviderHealthCanaryOptions({
        baseUrl: "https://marketplace.chasesets.com",
        authBaseUrl: "https://marketplace.chasesets.com",
        environment: "production-proof",
        checkedAt: "2026-06-12T12:00:00.000Z",
      }),
    ).toEqual([
      "Production settlement provider-health canary requires operator credentials (PRODUCTION_SETTLEMENT_CANARY_ACCOUNT_EMAIL/PASSWORD or PLATFORM_ADMIN_EMAIL/PASSWORD).",
      "Production proof reference is required.",
    ]);
  });

  it("parses workflow environment defaults", () => {
    expect(
      parseProductionSettlementProviderHealthCanaryArgs([], {
        PRODUCTION_SETTLEMENT_CANARY_BASE_URL: "https://marketplace.chasesets.com",
        PRODUCTION_SETTLEMENT_CANARY_ACCOUNT_EMAIL: "ops@example.test",
        PRODUCTION_SETTLEMENT_CANARY_ACCOUNT_PASSWORD: "secret",
        PRODUCTION_MARKETPLACE_PROOF_REFERENCE: "PRODUCTION-PROOF-2026-06-12",
      }),
    ).toMatchObject({
      baseUrl: "https://marketplace.chasesets.com",
      authBaseUrl: "https://marketplace.chasesets.com",
      email: "ops@example.test",
      password: "secret",
      environment: "production-proof",
      productionProofReference: "PRODUCTION-PROOF-2026-06-12",
    });
  });
});
