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
import { module as inventoryModule } from "@chase-sets/inventory";
import { createStorageLocationAuthority } from "@chase-sets/inventory/server";
import type { ChannelConnectionHostPorts, ChannelConnectionSetupDeclaration } from "../domain/contracts";
import { testContext } from "./test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels" | "inventory", PgTransactionalPool>>;

describeDb("channel-connection-setup-activation", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["channels", "inventory"],
      "channel_connection_setup",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
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
    const services = channelsModule.createServices(pools.channels, {
      ...ports,
      channelSaleRecorder: async (): Promise<never> => {
        throw new Error("not reached");
      },
    }).connections;
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

  it("channel-connection-activate-authority-matrix: binds stream versions and refuses retired, foreign, missing and empty with zero events", async () => {
    const inventory = inventoryModule.createServices(pools.inventory, {}).storageLocations;
    const authority = createStorageLocationAuthority(pools.inventory);
    const services = channelsModule.createServices(pools.channels, {
      storageLocationAuthority: { resolve: authority.resolveStorageLocationAuthority },
      channelSaleRecorder: async (): Promise<never> => {
        throw new Error("not reached");
      },
    }).connections;
    const address = {
      name: "Seller",
      company: null,
      line1: "123 Main St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
    };
    const first = await inventory.createStorageLocation(
      { accountId: "acc_owner" as never, name: "First", shipFromCode: "first", shipFromAddress: address },
      testContext,
    );
    const second = await inventory.createStorageLocation(
      { accountId: "acc_owner" as never, name: "Second", shipFromCode: "second", shipFromAddress: address },
      testContext,
    );
    const updated = await inventory.updateStorageLocation(
      {
        accountId: "acc_owner",
        storageLocationId: first.storageLocationId,
        name: "Updated",
        shipFromCode: "first",
        shipFromAddress: address,
      },
      testContext,
    );
    // The authority still resolves after removing its projection: the committed stream owns both state and revision.
    await pools.inventory.query("DELETE FROM inventory_storage_locations WHERE storage_location_id = $1", [
      first.storageLocationId,
    ]);
    expect(
      await authority.resolveStorageLocationAuthority({
        accountId: "acc_owner",
        storageLocationId: first.storageLocationId,
      }),
    ).toEqual({
      accountId: "acc_owner",
      storageLocationId: first.storageLocationId,
      revision: updated.version,
      status: "active",
    });
    const bindings = [
      { storageLocationId: first.storageLocationId, revision: updated.version },
      { storageLocationId: second.storageLocationId, revision: second.version },
    ];
    await services.connectChannel(
      { accountId: "acc_owner", connectionId: "real", providerKey: "tcgplayer" },
      { deploymentEnvironment: "test" },
      testContext,
    );
    const result = await services.activateChannelConnection(
      { accountId: "acc_owner", connectionId: "real", bindings },
      testContext,
    );
    expect(result.state).toMatchObject({ status: "active", bindings });
    const archived = await inventory.updateStorageLocation(
      {
        accountId: "acc_owner",
        storageLocationId: second.storageLocationId,
        name: "Second",
        shipFromCode: "second",
        shipFromAddress: address,
        isArchived: true,
      },
      testContext,
    );
    expect(
      await authority.resolveStorageLocationAuthority({
        accountId: "acc_owner",
        storageLocationId: second.storageLocationId,
      }),
    ).toMatchObject({ revision: archived.version, status: "retired" });
    expect(
      await authority.resolveStorageLocationAuthority({
        accountId: "acc_other",
        storageLocationId: first.storageLocationId,
      }),
    ).toBeNull();
    for (const [name, accountId, candidates, code] of [
      [
        "retired",
        "acc_owner",
        [{ storageLocationId: second.storageLocationId, revision: archived.version }],
        "binding-not-current",
      ],
      ["foreign", "acc_other", bindings, "binding-not-current"],
      ["missing", "acc_owner", [{ storageLocationId: "missing", revision: 1 }], "binding-not-current"],
      ["empty", "acc_owner", [], "binding-required"],
    ] as const) {
      await services.connectChannel(
        { accountId, connectionId: name, providerKey: "tcgplayer" },
        { deploymentEnvironment: "test" },
        testContext,
      );
      await expect(
        services.activateChannelConnection({ accountId, connectionId: name, bindings: candidates }, testContext),
      ).rejects.toMatchObject({ code });
      const count = await pools.channels.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM event_store_events WHERE stream_id = $1",
        [`channels.connection-${name}`],
      );
      expect(count.rows[0]?.count).toBe("1");
    }
  });
});

function setup(): ChannelConnectionSetupDeclaration {
  return {
    providerKey: "fixture-provider",
    environment: "sandbox",
    requirements: { credential: "required", requiredPolicyKeys: [], binding: "one-or-more-current" },
  };
}
