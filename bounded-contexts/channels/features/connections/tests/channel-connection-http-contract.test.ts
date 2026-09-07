import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import { channelConnectionRoutes } from "../api/route";
import type { ChannelConnectionServices, ChannelConnectionState, PublicChannelConnection } from "../domain/contracts";
import { testContext } from "./test-support";

const dto: PublicChannelConnection = {
  connectionId: "connection_1",
  providerKey: "fixture-provider",
  environment: "sandbox",
  status: "active",
  createdAt: "2026-09-05T00:00:00.000Z",
};

describe("channel-connection-http-contract", () => {
  it("exposes exactly the five public connection method/path rows", () => {
    const routes = channelConnectionRoutes(createServices()).routes.map(({ method, path }) => `${method} ${path}`);
    expect(routes).toEqual(["GET /", "GET /:id", "POST /:id/pause", "POST /:id/resume", "POST /:id/disconnect"]);
  });

  it("returns the exact closed DTO across list, detail, and all three committed mutations", async () => {
    const app = createApp(createServices());
    for (const request of [
      new Request("http://local/api/channels/connections"),
      new Request("http://local/api/channels/connections/connection_1"),
      new Request("http://local/api/channels/connections/connection_1/pause", { method: "POST" }),
      new Request("http://local/api/channels/connections/connection_1/resume", { method: "POST" }),
      new Request("http://local/api/channels/connections/connection_1/disconnect", { method: "POST" }),
    ]) {
      const response = await app.request(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      const item = "items" in body ? body.items[0] : body;
      expect(Object.keys(item)).toEqual(["connectionId", "providerKey", "environment", "status", "createdAt"]);
      expect(item).toEqual(dto);
      expect(JSON.stringify(body)).not.toMatch(/accountId|credentialReference|bindings|adversarial-secret-marker/);
    }
  });

  it("rejects renamed actions, public connect/activate, request bodies, and invalid paging uniformly", async () => {
    const app = createApp(createServices());
    for (const [path, method, expected] of [
      ["/api/channels/connections/connection_1/paused", "POST", 404],
      ["/api/channels/connections/connect", "POST", 404],
      ["/api/channels/connections/connection_1/activate", "POST", 404],
      ["/api/channels/connections?unknown=x", "GET", 400],
      ["/api/channels/connections?limit=101", "GET", 400],
      ["/api/channels/connections?status=unknown", "GET", 400],
    ] as const) {
      expect((await app.request(`http://local${path}`, { method })).status).toBe(expected);
    }
    const bodyResponse = await app.request("http://local/api/channels/connections/connection_1/resume", {
      method: "POST",
      body: JSON.stringify({ credentialReference: "should-not-be-accepted" }),
    });
    expect(bodyResponse.status).toBe(400);
  });

  it("normalizes absent and foreign detail to the same 404", async () => {
    const services = createServices();
    services.getConnection = async () => null;
    const response = await createApp(services).request("http://local/api/channels/connections/foreign");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "connection-not-found", message: "connection-not-found" },
    });
  });
});

function createApp(services: ChannelConnectionServices, permissions = ["channels.view", "channels.manage"]) {
  const app = new Hono<ChannelsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { accountId: "acc_owner", permissions });
    c.set("context", testContext);
    await next();
  });
  app.route("/api/channels", buildChannelsApi({ connections: services, projectors: [] }));
  return app;
}

function createServices(): ChannelConnectionServices {
  const state: ChannelConnectionState = {
    ...dto,
    accountId: "acc_owner",
    credentialReference: "credential-reference-1",
    bindings: [{ storageLocationId: "location_1", revision: 1 }],
  };
  const command = async () => ({ state, version: 2, newEvents: [], storedEvents: [] });
  return {
    connectChannel: command,
    activateChannelConnection: command,
    pauseChannelConnection: command,
    resumeChannelConnection: command,
    disconnectChannelConnection: command,
    getConnection: async () => dto,
    listConnections: async () => ({ items: [dto] }),
    projectors: [],
  };
}
