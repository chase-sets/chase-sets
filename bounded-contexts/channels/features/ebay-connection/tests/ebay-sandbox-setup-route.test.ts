import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import { createChannelsServicesForTest } from "../../../tests/channels-services-test-support";
import { testContext } from "../../connections/tests/test-support";
import { EbaySetupError } from "../domain/setup-material";
import { readSetupLists } from "../api/setup-listing";
import { choice, setupRead } from "./setup-fixtures";

function harness() {
  const services = createChannelsServicesForTest();
  const load = vi.spyOn(services.ebaySellerSetup!, "load");
  const select = vi.spyOn(services.ebaySellerSetup!, "select");
  const app = new Hono<ChannelsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { accountId: "acc_owner", permissions: ["channels.view", "channels.manage"] });
    c.set("context", testContext);
    await next();
  });
  app.route("/", buildChannelsApi(services));
  const path = "/ebay/connections/synthetic-connection/setup";
  const post = (body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, path, post, load, select };
}

describe("ebay-sandbox-setup-route", () => {
  it("loads seller setup for the authenticated account and requested connection", async () => {
    const test = harness();
    const setup = { selection: null, lists: await readSetupLists("synthetic-token", setupRead) };
    test.load.mockResolvedValue(setup);

    const response = await test.app.request(test.path);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(setup);
    expect(test.load).toHaveBeenCalledExactlyOnceWith({
      accountId: "acc_owner",
      connectionId: "synthetic-connection",
    });
    expect(test.select).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("selects seller setup with the submitted choices and request context", async () => {
    const test = harness();
    const command = choice();
    const selection = {
      connectionId: "synthetic-connection",
      setupGeneration: 1,
      policies: command.policies.map((item) => ({ ...item, materialFingerprint: `v1:${"a".repeat(64)}` })),
      locationPairs: command.locationPairs.map((item) => ({ ...item, materialFingerprint: `v1:${"b".repeat(64)}` })),
    };
    const result = { selection, status: "active" as const };
    test.select.mockResolvedValue(result);

    const response = await test.post(command);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(test.select).toHaveBeenCalledExactlyOnceWith(
      { accountId: "acc_owner", connectionId: "synthetic-connection" },
      command,
      testContext,
    );
    expect(test.load).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("returns a closed conflict response when setup selection is refused", async () => {
    const test = harness();
    test.select.mockRejectedValue(new EbaySetupError("generation-conflict"));

    const response = await test.post(choice());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "generation-conflict" } });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
