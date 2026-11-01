import { vi } from "vitest";
import { isChannelsServices } from "@chase-sets/channels/server";
import { buildPlatformApiApp, createPlatformApiHost, type BuildPlatformApiOptions } from "../src/app";
import { createPlatformApiPools, closePlatformApiPools } from "../src/database-pools";

export const receiptActorToken = "synthetic_receipt_actor_token_01234567890123456789";
export const receiptActorCredential = JSON.stringify({
  version: 1,
  token: receiptActorToken,
  expiresAt: "2099-01-01T00:00:00Z",
});
export const receiptActorOrigin = "https://admin.staging.chasesets.com";
export const receiptActorPath = "/api/channels/staff/ebay-account-deletion/lookup";

export function receiptActorHarness() {
  const pools = createPlatformApiPools({
    runtimeProfile: "public",
    sharedDatabaseUrl: "postgresql://localhost/synthetic_no_database_calls",
    contextDatabaseUrls: {},
    port: 6182,
  });
  const runtime = createPlatformApiHost({
    runtimeProfile: "public",
    pools,
    hostPorts: { capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" } },
  });
  const channels = runtime.services.channels;
  if (!isChannelsServices(channels)) throw new Error("Channels not mounted in actual API host");
  const lookup = vi.spyOn(channels.ebayAccountDeletionReceipts, "lookup").mockResolvedValue([]);
  const count = vi
    .spyOn(channels.ebayAccountDeletionReceipts, "countSubjectData")
    .mockResolvedValue({ connections: 0, credentialEnvelopes: 0 });
  const storage = vi.spyOn(channels.db, "query");
  const readCredential = vi.fn((): unknown => receiptActorCredential);
  const human = vi.fn<NonNullable<BuildPlatformApiOptions["resolveActor"]>>(async () => null);
  function compose(options: BuildPlatformApiOptions = {}) {
    return buildPlatformApiApp(runtime, {
      resolveActor: human,
      receiptLookupActor: { deploymentEnvironment: "staging", readCredential },
      ...options,
    });
  }
  function request(
    app: ReturnType<typeof compose>,
    options: { path?: string; origin?: string; method?: string; headers?: HeadersInit; body?: string } = {},
  ) {
    return app.request(`${options.origin ?? receiptActorOrigin}${options.path ?? receiptActorPath}`, {
      method: options.method ?? "POST",
      headers: {
        authorization: `Bearer ${receiptActorToken}`,
        "content-type": "application/json",
        ...Object.fromEntries(new Headers(options.headers)),
      },
      ...((options.method ?? "POST") === "GET" || options.method === "HEAD"
        ? {}
        : { body: options.body ?? JSON.stringify({ userId: "synthetic-subject" }) }),
    });
  }
  return { compose, request, lookup, count, storage, readCredential, human, close: () => closePlatformApiPools(pools) };
}
