import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { Hono } from "hono";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../index";
import { buildChannelsApi, type ChannelsApiEnv } from "../api";
import {
  channelsServicesMembers,
  isChannelsServices,
  type ChannelsServices,
} from "../support/runtime-support/services";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

describeDb("channels-services-composition", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "channels_services_composition");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    await bootstrapContextDatabase(channelsModule, pools.channels);
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("pins the aggregate contract to the real composed service", () => {
    const services = channelsModule.createServices(pools.channels, {});

    expect(Object.keys(services).sort()).toEqual([...channelsServicesMembers].sort());
    expect(isChannelsServices(services)).toBe(true);
    expectTypeOf<(typeof channelsServicesMembers)[number]>().toEqualTypeOf<keyof ChannelsServices>();
    expect(channelsServicesMembers).toContain("connectionHealth");
  });

  it.each(["submitObservation", "readConnectionHealth", "listOpenReasonGenerations"])(
    "rejects real composition when the health %s source is omitted",
    (member) => {
      const services = channelsModule.createServices(pools.channels, {});
      expect(
        isChannelsServices({
          ...services,
          connectionHealth: Object.fromEntries(
            Object.entries(services.connectionHealth).filter(([key]) => key !== member),
          ),
        }),
      ).toBe(false);
    },
  );

  it.each(channelsServicesMembers)("rejects real composition with %s omitted", (member) => {
    const services = channelsModule.createServices(pools.channels, {});
    const missingMember = Object.fromEntries(Object.entries(services).filter(([key]) => key !== member));
    expect(Object.keys(missingMember).sort()).not.toEqual([...channelsServicesMembers].sort());
    expect(isChannelsServices(missingMember)).toBe(false);
  });

  it("serves the connection API through the validated real composition", async () => {
    const candidate: unknown = channelsModule.createServices(pools.channels, {});
    if (!isChannelsServices(candidate)) throw new Error("Real Channels composition was rejected");
    const app = new Hono<ChannelsApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: "account_channels_composition", permissions: ["channels.view"] });
      await next();
    });
    app.route("/api/channels", buildChannelsApi(candidate));
    const response = await app.request("http://local/api/channels/connections/missing-connection");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "connection-not-found", message: "connection-not-found" },
    });
  });
});
