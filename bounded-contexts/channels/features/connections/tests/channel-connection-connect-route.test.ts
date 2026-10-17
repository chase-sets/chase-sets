import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import { createChannelsServicesForTest } from "../../../tests/channels-services-test-support";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import { listConnectableChannelProviders } from "../api/providers";
import type { ChannelConnectionHostPorts, PublicChannelConnection } from "../domain/contracts";
import { toPublicChannelConnection } from "../read-model/queries";
import { createConnectionHarness, testContext } from "./test-support";

function harness(overrides: ChannelConnectionHostPorts = {}, permissions = ["channels.view", "channels.manage"]) {
  const runtime = createConnectionHarness({ setupResolver: channelProviderRegistry.setupResolver, ...overrides });
  const snapshots = new Map<string, PublicChannelConnection>();
  const connect = runtime.services.connectChannel;
  const activate = vi.spyOn(runtime.services, "activateChannelConnection");
  runtime.services.connectChannel = async (...args) => {
    const result = await connect(...args);
    snapshots.set(result.state.connectionId!, toPublicChannelConnection(result.state));
    return result;
  };
  runtime.services.getConnection = async ({ accountId, connectionId }) =>
    accountId === "acc_owner" ? (snapshots.get(connectionId) ?? null) : null;
  const app = new Hono<ChannelsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { accountId: "acc_owner", permissions });
    c.set("context", testContext);
    await next();
  });
  app.route(
    "/connections",
    buildChannelsApi(
      { ...createChannelsServicesForTest(), connections: runtime.services },
      {
        deploymentEnvironment: "production",
        storageLocationAuthority: runtime.ports.storageLocationAuthority,
      },
    ),
  );
  const post = (path: string, body: unknown) =>
    app.request(`/connections/connections${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const create = async () => {
    const response = await post("", { providerKey: "tcgplayer" });
    expect(response.status).toBe(201);
    return (await response.json()) as PublicChannelConnection;
  };
  return { ...runtime, post, create, activate };
}

describe("channel-connection-connect-route", () => {
  it.each(["setup-unregistered", "policy-incomplete", "binding-retired", "foreign-account"] as const)(
    "shared activation guard kills the %s one-clause bypass",
    async (kind) => {
      let connected = false;
      const runtime = createConnectionHarness({
        setupResolver: {
          resolve: async (input) =>
            connected && kind === "setup-unregistered" ? null : channelProviderRegistry.setupResolver.resolve(input),
        },
        policyAuthority: {
          resolve: async ({ policyKey }) => ({
            policyKey,
            revision: 0,
            status: kind === "policy-incomplete" ? "incomplete" : "complete",
          }),
        },
        storageLocationAuthority: {
          resolve: async ({ storageLocationId }) => ({
            accountId: kind === "foreign-account" ? "acc_other" : "acc_owner",
            storageLocationId,
            revision: 1,
            status: kind === "binding-retired" ? "retired" : "active",
          }),
        },
      });
      await runtime.services.connectChannel(
        { accountId: "acc_owner", connectionId: "guard", providerKey: "tcgplayer" },
        { deploymentEnvironment: "test" },
        testContext,
      );
      connected = true;
      await expect(
        runtime.services.activateChannelConnection(
          { accountId: "acc_owner", connectionId: "guard", bindings: [{ storageLocationId: "location", revision: 1 }] },
          testContext,
        ),
      ).rejects.toMatchObject({
        code:
          kind === "setup-unregistered"
            ? "provider-setup-not-registered"
            : kind === "policy-incomplete"
              ? "required-policy-incomplete"
              : "binding-not-current",
      });
      expect(runtime.memory.streams.get("channels.connection-guard")).toHaveLength(1);
    },
  );

  it("creates independent pending connections with server identities and deployment-owned environment", async () => {
    const test = harness();
    const first = await test.create();
    const second = await test.create();
    expect(first).toMatchObject({ providerKey: "tcgplayer", environment: "production", status: "pending-setup" });
    expect(first.connectionId).not.toBe(second.connectionId);
    expect(test.memory.streams.size).toBe(2);
    expect(await listConnectableChannelProviders("production")).toEqual(["tcgplayer"]);
    expect(await listConnectableChannelProviders("test")).toEqual(["tcgplayer"]);
  });

  it.each([
    null,
    [],
    {},
    { providerKey: { key: "tcgplayer" } },
    { providerKey: "tcgplayer", environment: "sandbox" },
    { providerKey: "tcgplayer", connectionId: "chosen" },
    { providerKey: "tcgplayer", extra: {} },
  ])("recursively closes creation input: %j", async (body) => {
    const test = harness();
    expect((await test.post("", body)).status).toBe(400);
    expect(test.memory.streams.size).toBe(0);
  });

  it("requires manage permission before a command and refuses unregistered setup", async () => {
    const forbidden = harness({}, ["channels.view"]);
    expect((await forbidden.post("", { providerKey: "tcgplayer" })).status).toBe(403);
    expect(forbidden.memory.streams.size).toBe(0);
    const unregistered = harness();
    const response = await unregistered.post("", { providerKey: "missing" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "provider-setup-not-registered", message: "provider-setup-not-registered" },
    });
    expect(unregistered.memory.streams.size).toBe(0);
  });

  it("authors activation bindings from current authority, not browser revisions", async () => {
    const test = harness();
    const connection = await test.create();
    const response = await test.post(`/${connection.connectionId}/activate`, {
      storageLocationIds: ["location_7", "location_9"],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "active" });
    expect(test.activate).toHaveBeenCalledWith(
      {
        accountId: "acc_owner",
        connectionId: connection.connectionId,
        bindings: [
          { storageLocationId: "location_7", revision: 7 },
          { storageLocationId: "location_9", revision: 9 },
        ],
      },
      testContext,
    );
    expect(test.memory.streams.get(`channels.connection-${connection.connectionId}`)).toHaveLength(2);
    expect(test.authorityCalls.storage).toBe(2);
  });

  it("loads each selected authority once per request and reads again for a later activation and resume", async () => {
    let revision = 1;
    const resolve = vi.fn(
      async ({ accountId, storageLocationId }: { accountId: string; storageLocationId: string }) => ({
        accountId,
        storageLocationId,
        revision,
        status: "active" as const,
      }),
    );
    const test = harness({ storageLocationAuthority: { resolve } });
    const first = await test.create();
    const second = await test.create();
    const body = { storageLocationIds: ["location_1", "location_2"] };
    expect((await test.post(`/${first.connectionId}/activate`, body)).status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(2);
    revision = 2;
    expect((await test.post(`/${second.connectionId}/activate`, body)).status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(test.activate.mock.calls[1]?.[0].bindings).toEqual([
      { storageLocationId: "location_1", revision: 2 },
      { storageLocationId: "location_2", revision: 2 },
    ]);
    expect((await test.post(`/${first.connectionId}/pause`, undefined)).status).toBe(200);
    expect((await test.post(`/${first.connectionId}/resume`, undefined)).status).toBe(409);
    expect(resolve).toHaveBeenCalledTimes(5);
  });

  it.each([
    null,
    {},
    { storageLocationIds: [{ storageLocationId: "location_1", revision: 1 }] },
    { storageLocationIds: ["location_1"], bindings: [] },
    { storageLocationIds: ["location_1", "location_1"] },
    { storageLocationIds: ["location_1"], revision: 1 },
    { storageLocationIds: Array.from({ length: 201 }, (_, i) => `location_${i}`) },
  ])("recursively closes activation input: %j", async (body) => {
    const test = harness();
    const connection = await test.create();
    expect((await test.post(`/${connection.connectionId}/activate`, body)).status).toBe(400);
    expect(test.activate).not.toHaveBeenCalled();
    expect(test.memory.streams.get(`channels.connection-${connection.connectionId}`)).toHaveLength(1);
  });

  it.each(["retired", "foreign", "missing", "unavailable", "empty", "policy"] as const)(
    "refuses %s with 409 and no event",
    async (kind) => {
      const test = harness({
        ...(kind === "policy" ? { policyAuthority: { resolve: async () => null } } : {}),
        storageLocationAuthority: {
          resolve: async ({ storageLocationId }) => {
            if (kind === "unavailable") throw new Error("inventory unavailable");
            if (kind === "missing") return null;
            return {
              accountId: kind === "foreign" ? "acc_other" : "acc_owner",
              storageLocationId,
              revision: 1,
              status: kind === "retired" ? "retired" : "active",
            };
          },
        },
      });
      const connection = await test.create();
      const response = await test.post(`/${connection.connectionId}/activate`, {
        storageLocationIds: kind === "empty" ? [] : ["location_1"],
      });
      expect(response.status).toBe(409);
      const code =
        kind === "empty"
          ? "binding-required"
          : kind === "policy"
            ? "required-policy-incomplete"
            : "binding-not-current";
      expect(await response.json()).toEqual({ error: { code, message: code } });
      expect(test.memory.streams.get(`channels.connection-${connection.connectionId}`)).toHaveLength(1);
    },
  );

  it("makes absent and foreign connection activation identical without authority I/O", async () => {
    const test = harness();
    const connection = await test.create();
    test.services.getConnection = async () => null;
    const foreign = await test.post(`/${connection.connectionId}/activate`, { storageLocationIds: ["location_1"] });
    const missing = await test.post("/missing/activate", { storageLocationIds: ["location_1"] });
    expect(foreign.status).toBe(404);
    expect({ status: foreign.status, body: await foreign.text() }).toEqual({
      status: missing.status,
      body: await missing.text(),
    });
    expect(test.authorityCalls.storage).toBe(0);
  });
});
