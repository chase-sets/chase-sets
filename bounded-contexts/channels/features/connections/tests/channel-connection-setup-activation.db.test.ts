import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import type { ChannelConnectionHostPorts, ChannelConnectionSetupDeclaration } from "../domain/contracts";
import { testContext } from "./test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

describeDb("channel-connection-setup-activation", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "channel_connection_setup");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  it("persists connect once and leaves the pending stream unchanged when its declaration is removed", async () => {
    let declaration: ChannelConnectionSetupDeclaration | null = setup();
    const calls = { credential: 0, policy: 0, storage: 0 };
    const ports: ChannelConnectionHostPorts = {
      setupResolver: { resolve: async () => declaration },
      credentialAuthority: {
        resolve: async () => {
          calls.credential += 1;
          return null;
        },
      },
      policyAuthority: {
        resolve: async () => {
          calls.policy += 1;
          return null;
        },
      },
      storageLocationAuthority: {
        resolve: async () => {
          calls.storage += 1;
          return null;
        },
      },
      clock: { now: () => "2026-09-05T12:34:56.789-05:00" },
    };
    const services = channelsModule.createServices(pools.channels, ports).connections;
    const connected = await services.connectChannel(
      { connectionId: "connection_db_1", accountId: "acc_owner", providerKey: "fixture-provider" },
      { deploymentEnvironment: "test" },
      testContext,
    );
    expect(connected).toMatchObject({
      state: { status: "pending-setup", credentialReference: null, bindings: [] },
      version: 1,
    });
    declaration = null;
    await expect(
      services.activateChannelConnection(
        {
          accountId: "acc_owner",
          connectionId: "connection_db_1",
          credentialReference: "credential-reference-1",
          bindings: [{ storageLocationId: "location_1", revision: 1 }],
        },
        testContext,
      ),
    ).rejects.toMatchObject({ code: "provider-setup-not-registered" });
    expect(calls).toEqual({ credential: 0, policy: 0, storage: 0 });
    const count = await pools.channels.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM event_store_events WHERE stream_id = $1",
      ["channels.connection-connection_db_1"],
    );
    expect(count.rows[0]?.count).toBe("1");
  });
});

function setup(): ChannelConnectionSetupDeclaration {
  return {
    providerKey: "fixture-provider",
    environment: "sandbox",
    requirements: { credential: "required", requiredPolicyKeys: [], binding: "one-or-more-current" },
  };
}
