import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import {
  CHANNELS_EBAY_ACCOUNT_DELETION_PATH,
  parseEbayAccountDeletionConfiguration,
} from "@chase-sets/channels/server";
import { createPlatformApiHost, buildPlatformApiApp } from "../src/app";
import { apiContextRegistry } from "../src/context-registry";
import { createFakePaymentProcessorGateway } from "../../platform-worker/src/test-support/provider-gateways";

vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
  createPostgresEventStore: () => createInMemoryEventStore().eventStore,
}));
describe("ebay-account-deletion-composition", () => {
  it.each([true, false])("keeps seller auth and deployment-only hashing with configured=%s", async (enabled) => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query, connect: async () => ({ query, release: () => {} }) };
    const record = vi.fn();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const runtime = createPlatformApiHost({
      pools: Object.fromEntries(apiContextRegistry.map((entry) => [entry.contextName, pool])),
      runtimeProfile: "public",
      hostPorts: {
        capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
        processorGateway: createFakePaymentProcessorGateway(),
        ebayAccountDeletionConfiguration: enabled
          ? parseEbayAccountDeletionConfiguration(
              "https://Example.com:443/api/channels-webhooks/ebay/account-deletion",
              "synthetic_verification_token_0123456789",
              { clientId: "synthetic-client", clientSecret: "synthetic-secret", environment: "sandbox" },
            )
          : null,
        webhookTelemetry: { record },
      },
    });
    const app = buildPlatformApiApp(runtime);
    for (const headers of [
      new Headers(),
      new Headers({
        host: "attacker.example",
        forwarded: "host=attacker.example;proto=http",
        "x-forwarded-host": "attacker.example",
      }),
    ]) {
      const response = await app.request(CHANNELS_EBAY_ACCOUNT_DELETION_PATH + "?challenge_code=synthetic-challenge", {
        headers,
      });
      expect(response.status).toBe(enabled ? 200 : 503);
      if (enabled)
        expect(await response.json()).toEqual({
          challengeResponse: "2f0e4dfc1e2fe419ee360cce032d9103077c870455ceb04b1ef0e1d756be53d2",
        });
    }
    expect((await app.request(CHANNELS_EBAY_ACCOUNT_DELETION_PATH, { method: "POST" })).status).toBe(
      enabled ? 415 : 503,
    );
    for (const method of ["HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect((await app.request(CHANNELS_EBAY_ACCOUNT_DELETION_PATH, { method })).status).toBe(405);
    }
    expect((await app.request("/api/channels/connections")).status).toBe(401);
    expect(record).toHaveBeenCalledTimes(8);
    expect(query).not.toHaveBeenCalled();
    await app.request("/health");
    expect(
      fetcher.mock.calls.filter(([url]) => {
        const hostname = new URL(String(url)).hostname;
        return hostname === "ebay.com" || hostname.endsWith(".ebay.com");
      }),
    ).toEqual([]);
    fetcher.mockRestore();
  });
});
