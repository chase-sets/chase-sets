import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import { createChannelsServicesForTest } from "../../../tests/channels-services-test-support";
import type { ChannelConnectionServices } from "../domain/contracts";
import { channelConnectionRoutes } from "../api/route";
import { createUnavailableOutboundSyncServices } from "../../outbound-sync/tests/test-support";
import { createUnavailableListingCompositionServices } from "../../listing-composition/tests/service-stub";
import { testContext } from "./test-support";

describe("channel-connection-providers-route", () => {
  it.each([
    ["production", [{ providerKey: "tcgplayer", environment: "production" }]],
    ["test", [{ providerKey: "tcgplayer", environment: "sandbox" }]],
  ] as const)("returns registry identities in order for %s", async (deploymentEnvironment, expected) => {
    const response = await createApp(deploymentEnvironment).request("http://local/api/channels/connections/providers");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: expected });
  });

  it("returns an empty list for view-only callers", async () => {
    const response = await createApp("production", ["channels.view"]).request(
      "http://local/api/channels/connections/providers",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  it("requires view permission and rejects query parameters", async () => {
    const forbidden = await createApp("production", []).request("http://local/api/channels/connections/providers");
    expect(forbidden.status).toBe(403);
    const query = await createApp("production").request("http://local/api/channels/connections/providers?x=1");
    expect(query.status).toBe(400);
    expect(await query.json()).toEqual({ error: { code: "invalid-request", message: "invalid-request" } });
  });

  it("is mounted before the detail parameter route", () => {
    const routes = channelConnectionRoutes(createServices()).routes.map(({ method, path }) => `${method} ${path}`);
    expect(routes).toContain("GET /providers");
    expect(routes.indexOf("GET /providers")).toBeLessThan(routes.indexOf("GET /:id"));
  });
});

function createApp(deploymentEnvironment: "production" | "test", permissions = ["channels.view", "channels.manage"]) {
  const app = new Hono<ChannelsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { accountId: "acc_owner", permissions });
    c.set("context", testContext);
    await next();
  });
  app.route(
    "/api/channels",
    buildChannelsApi(
      {
        ...createChannelsServicesForTest(),
        connections: createServices(),
        outboundSync: createUnavailableOutboundSyncServices(),
        listingComposition: createUnavailableListingCompositionServices(),
        projectors: [],
      },
      { deploymentEnvironment },
    ),
  );
  return app;
}

function createServices(): ChannelConnectionServices {
  return {
    connectChannel: async () => {
      throw new Error("unused");
    },
    activateChannelConnection: async () => {
      throw new Error("unused");
    },
    pauseChannelConnection: async () => {
      throw new Error("unused");
    },
    resumeChannelConnection: async () => {
      throw new Error("unused");
    },
    disconnectChannelConnection: async () => {
      throw new Error("unused");
    },
    getConnection: async () => null,
    listConnections: async () => ({ items: [] }),
    projectors: [],
  };
}
