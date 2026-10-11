import { afterEach, describe, expect, it, vi } from "vitest";
import { isChannelsServices } from "@chase-sets/channels/server";
import { buildPlatformApiApp, createPlatformApiHost } from "../src/app";
import { createPlatformApiPools, closePlatformApiPools } from "../src/database-pools";

const openedPools: ReturnType<typeof createPlatformApiPools>[] = [];
afterEach(async () => {
  for (const pools of openedPools.splice(0)) await closePlatformApiPools(pools);
});

describe("ebay-account-deletion staff host composition", () => {
  function compose(permissions: readonly string[] | null) {
    const pools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: "postgresql://localhost/synthetic_no_database_calls",
      contextDatabaseUrls: {},
      port: 6182,
    });
    openedPools.push(pools);
    const runtime = createPlatformApiHost({ runtimeProfile: "public", pools, hostPorts: {} });
    const channels = runtime.services.channels;
    if (!isChannelsServices(channels)) throw new Error("Channels not mounted in actual API host");
    const lookup = vi
      .spyOn(channels.ebayAccountDeletion, "lookup")
      .mockResolvedValue([
        { notificationId: "synthetic-notice", eventDate: "2026-10-11T00:00:00Z", expiresAt: "2026-11-10T00:00:00Z" },
      ]);
    vi.spyOn(channels.ebayAccountDeletion, "countSubjectData").mockResolvedValue({
      connections: 0,
      credentialEnvelopes: 0,
    });
    const app = buildPlatformApiApp(runtime, {
      resolveActor: async () =>
        permissions === null
          ? null
          : {
              sessionId: "synthetic-session",
              tenantId: "synthetic-tenant",
              userId: "synthetic-user",
              accountId: "synthetic-account",
              membershipId: "synthetic-member",
              roleKey: "staff",
              permissions,
            },
    });
    return { app, lookup };
  }
  it.each([
    [null, 401],
    [["channels.view", "channels.manage"], 403],
    [["support.manage"], 200],
  ] as const)("requires staff authority, independent of seller permissions (%j)", async (permissions, status) => {
    const { app, lookup } = compose(permissions);
    const marker = "synthetic-private-subject-marker";
    const response = await app.request("/api/channels/staff/ebay-account-deletion/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: marker }),
    });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(marker);
    expect(lookup).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    const count = await app.request("/api/channels/staff/ebay-account-deletion/subject-data-count");
    expect(count.status).toBe(status);
    if (status === 200) {
      expect(await count.json()).toEqual({ connections: 0, credentialEnvelopes: 0 });
      expect((await app.request("/api/channels/connections")).status).toBe(403);
    }
  });
  it("rejects closed-input violations and redacts service failures in the real host", async () => {
    const { app, lookup } = compose(["support.manage"]);
    const marker = "synthetic-error-subject-marker";
    lookup.mockRejectedValue(new Error(marker));
    for (const body of [{ userId: marker, extra: true }, { userId: marker }]) {
      const response = await app.request("/api/channels/staff/ebay-account-deletion/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe("extra" in body ? 400 : 503);
      expect(await response.text()).not.toContain(marker);
    }
  });
});
