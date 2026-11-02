import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isChannelsServices } from "@chase-sets/channels/server";
import { buildPlatformApiApp, createPlatformApiHost } from "../src/app";
import { createPlatformApiPools, closePlatformApiPools } from "../src/database-pools";
import {
  receiptActorCredential,
  receiptActorHarness,
  receiptActorOrigin,
  receiptActorPath,
} from "./ebay-receipt-actor-harness";

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
    const runtime = createPlatformApiHost({
      runtimeProfile: "public",
      pools,
      hostPorts: {
        capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
      },
    });
    const channels = runtime.services.channels;
    if (!isChannelsServices(channels)) throw new Error("Channels not mounted in actual API host");
    const lookup = vi
      .spyOn(channels.ebayAccountDeletionReceipts, "lookup")
      .mockResolvedValue([
        { notificationId: "synthetic-notice", eventDate: "2026-10-11T00:00:00Z", expiresAt: "2026-11-10T00:00:00Z" },
      ]);
    vi.spyOn(channels.ebayAccountDeletionReceipts, "countSubjectData").mockResolvedValue({
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
      headers: { "content-type": "application/json", cookie: "chase_sets_session=synthetic" },
      body: JSON.stringify({ userId: marker }),
    });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(marker);
    expect(lookup).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    const count = await app.request("/api/channels/staff/ebay-account-deletion/subject-data-count", {
      headers: { cookie: "chase_sets_session=synthetic" },
    });
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
        headers: { "content-type": "application/json", cookie: "chase_sets_session=synthetic" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe("extra" in body ? 400 : 503);
      expect(await response.text()).not.toContain(marker);
    }
  });
  it("never falls back from a service bearer attempt to a human support actor", async () => {
    const { app, lookup } = compose(["support.manage"]);
    const response = await app.request(
      "https://admin.staging.chasesets.com/api/channels/staff/ebay-account-deletion/lookup",
      {
        method: "POST",
        headers: { authorization: "Bearer synthetic-invalid-receipt-actor-token", "content-type": "application/json" },
        body: JSON.stringify({ userId: "synthetic-subject" }),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "receipt_actor_environment_forbidden" });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("staging receipt actor authority/operation AC2 AC4", () => {
  const h = receiptActorHarness();
  afterAll(h.close);
  beforeEach(() => {
    h.lookup.mockClear();
    h.count.mockClear();
    h.storage.mockClear();
    h.readCredential.mockClear();
    h.human.mockClear();
  });
  it.each(["production", "preview", "dev", "test", "local", "remote-dev", undefined])(
    "refuses trusted environment %s before credentials or storage even with valid synthetic K",
    async (deploymentEnvironment) => {
      const response = await h.request(
        h.compose({ receiptLookupActor: { deploymentEnvironment, readCredential: h.readCredential } }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "receipt_actor_environment_forbidden" });
      expect(h.readCredential).not.toHaveBeenCalled();
      expect(h.lookup).not.toHaveBeenCalled();
      expect(h.count).not.toHaveBeenCalled();
      expect(h.storage).not.toHaveBeenCalled();
      expect(h.human).not.toHaveBeenCalled();
    },
  );
  it.each([
    { origin: "https://admin.chasesets.com" },
    { origin: "https://marketplace.staging.chasesets.com" },
    {
      origin: "https://attacker.example",
      headers: { "x-forwarded-host": "admin.staging.chasesets.com", "x-forwarded-proto": "https" },
    },
    { headers: { origin: "https://admin.chasesets.com" } },
    { headers: { origin: "null" } },
    { headers: { host: "admin.chasesets.com" } },
  ])("refuses wrong host/origin with zero credential/storage work %#", async (options) => {
    const response = await h.request(h.compose(), options as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "receipt_actor_origin_forbidden" });
    expect(h.readCredential).not.toHaveBeenCalled();
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.storage).not.toHaveBeenCalled();
    expect(h.human).not.toHaveBeenCalled();
  });
  it("compares request facts to canonical config, never upgrades request headers to deployment authority", async () => {
    const app = h.compose({
      receiptLookupActor: { deploymentEnvironment: "production", readCredential: h.readCredential },
    });
    const response = await h.request(app, {
      headers: {
        origin: receiptActorOrigin,
        "x-deployment-environment": "staging",
        "x-forwarded-host": "admin.staging.chasesets.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "receipt_actor_environment_forbidden" });
    expect(h.readCredential).not.toHaveBeenCalled();
    expect(h.storage).not.toHaveBeenCalled();
  });
  it.each([
    ["GET", "/api/channels/staff/ebay-account-deletion/subject-data-count"],
    ["POST", "/api/channels/staff/ebay-account-deletion/sibling"],
    ["POST", "/api/channels/staff/other"],
    ["GET", receiptActorPath],
    ["PUT", receiptActorPath],
    ["DELETE", receiptActorPath],
    ["HEAD", receiptActorPath],
    ["OPTIONS", receiptActorPath],
  ])("allows only exact POST, denying %s %s before storage", async (method, path) => {
    const response = await h.request(h.compose(), { method, path });
    expect(response.status).toBe(403);
    if (method !== "HEAD") expect(await response.json()).toEqual({ error: "receipt_actor_operation_forbidden" });
    expect(h.readCredential).not.toHaveBeenCalled();
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.count).not.toHaveBeenCalled();
    expect(h.storage).not.toHaveBeenCalled();
    expect(h.human).not.toHaveBeenCalled();
  });
  it("keeps staging key withholding separate from environment rejection", async () => {
    h.readCredential.mockReturnValueOnce(undefined).mockReturnValueOnce(receiptActorCredential);
    const app = h.compose();
    expect((await h.request(app)).status).toBe(401);
    expect((await h.request(app)).status).toBe(200);
  });
  it("permits the exact service operation only with the declared permission", async () => {
    const response = await h.request(h.compose());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ matches: [] });
    expect(h.lookup).toHaveBeenCalledExactlyOnceWith("synthetic-subject");
  });
});
