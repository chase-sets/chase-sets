import { describe, expect, it } from "vitest";
import { parseEbayOAuthConfiguration, ebaySetupDeclaration } from "../domain/configuration";
import { Hono } from "hono";
import { module as channelsModule } from "../../../index";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import { testContext } from "../../connections/tests/test-support";

describe("ebay-sandbox-registration-gate", () => {
  it("serves exactly the host-gated Connect list, not a marketplace registry", async () => {
    for (const enabled of [false, true]) {
      const db = {
        query: async () => ({ rows: [] }),
        connect: async () => {
          throw new Error("not-used");
        },
      };
      const services = channelsModule.createServices(db, {
        channelSaleRecorder: async () => {
          throw new Error("not-used");
        },
        ebayOAuthConfiguration: enabled ? parseEbayOAuthConfiguration("sandbox", "app", "secret", "runame") : null,
      });
      const app = new Hono<ChannelsApiEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", { accountId: "acc_owner", permissions: ["channels.view", "channels.manage"] });
        c.set("context", testContext);
        await next();
      });
      app.route("/", buildChannelsApi(services, { deploymentEnvironment: "test" }));
      const response = await app.request("/connections/providers");
      expect(await response.json()).toEqual({
        items: [
          { providerKey: "tcgplayer", environment: "sandbox" },
          ...(enabled ? [{ providerKey: "ebay", environment: "sandbox" }] : []),
        ],
      });
      const rejected = await app.request("/ebay/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publication: false, connectionId: null, environment: "production" }),
      });
      expect(rejected.status).not.toBe(200);
      await expect(
        services.connections.connectChannel(
          { connectionId: "synthetic-id", accountId: "acc_owner", providerKey: "ebay" },
          { deploymentEnvironment: "test" },
          testContext,
        ),
      ).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect(channelProviderRegistry.list().some((provider) => provider.providerKey === "ebay")).toBe(false);
  });
  it("requires sandbox and all three host-owned values", () => {
    expect(parseEbayOAuthConfiguration("production", "app", "secret", "runame")).toBeNull();
    for (const missing of [0, 1, 2]) {
      const values = ["app", "secret", "runame"];
      values[missing] = "";
      expect(parseEbayOAuthConfiguration("sandbox", ...(values as [string, string, string]))).toBeNull();
    }
    expect(parseEbayOAuthConfiguration("sandbox", "app", "secret", "runame")).toEqual({
      environment: "sandbox",
      clientId: "app",
      clientSecret: "secret",
      ruName: "runame",
    });
    expect(ebaySetupDeclaration.requirements).toEqual({
      credential: "required",
      requiredPolicyKeys: ["ebay.fulfillment", "ebay.payment", "ebay.return"],
      binding: "one-or-more-current",
    });
  });
});
