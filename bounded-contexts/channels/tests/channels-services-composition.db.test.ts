import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../index";
import { channelsServicesMembers, isChannelsServices, type ChannelsServices } from "../server";

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

  afterAll(async () => closeMultiContextTestPools(pools));

  it("pins the aggregate contract to the real composed service", () => {
    const services = channelsModule.createServices(pools.channels, {});

    expect(Object.keys(services).sort()).toEqual([...channelsServicesMembers].sort());
    expect(isChannelsServices(services)).toBe(true);
    expectTypeOf<(typeof channelsServicesMembers)[number]>().toEqualTypeOf<keyof ChannelsServices>();

    const { tcgplayerCsv: omitted, ...missingMember } = services;
    expect(omitted).toBeDefined();
    expect(Object.keys(missingMember).sort()).not.toEqual([...channelsServicesMembers].sort());
    expect(isChannelsServices(missingMember)).toBe(false);
  });
});
