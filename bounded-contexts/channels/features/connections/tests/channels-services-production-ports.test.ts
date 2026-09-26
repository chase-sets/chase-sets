import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { module as channelsModule } from "../../../index";
import { createConnectionHarness, testContext } from "./test-support";
import { channelProviderRegistry } from "../../publication-port/api/registry";

const root = path.resolve(import.meta.dirname, "../../../../..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("channels-services-production-ports", () => {
  it("wires the Inventory authority beside the sale recorder in API and worker; bootstrap and seed inherit the API host", () => {
    for (const file of ["deployables/platform-api/src/app.ts", "deployables/platform-worker/src/main.ts"]) {
      const text = source(file);
      expect(text).toContain("storageLocationAuthority:");
      expect(text).toMatch(
        /createStorageLocationAuthority\((?:inventoryPool|pools.inventory)\)\.resolveStorageLocationAuthority/,
      );
      expect(text).toContain("channelSaleRecorder");
    }
    for (const file of [
      "deployables/platform-api/src/bootstrap.ts",
      "deployables/platform-api/src/admin-qa-actor-fixtures.ts",
      "deployables/platform-api/src/representative-commerce-state.ts",
    ]) {
      expect(source(file)).toMatch(/\bcreatePlatformApiHost\s*\(\{/);
    }
    const module = source("bounded-contexts/channels/index.ts");
    expect(module).toContain("policyAuthority: ports.policyAuthority ?? createConnectionPolicyAuthority(policies)");
    expect(module).toContain("storageLocationAuthority: services.storageLocationAuthority");
    const seed = source("bounded-contexts/channels/features/manual-sync/api/seed.ts");
    expect(seed).toContain('eventType: "channels.connection.activated"');
    expect(seed).not.toContain("activateChannelConnection(");
  });

  it("fails fast at createServices with the named guard when the Inventory pool cannot supply its sale recorder", () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("not reached");
    };
    expect(() =>
      Reflect.apply(channelsModule.createServices, undefined, [
        { query: unavailable, connect: unavailable },
        { storageLocationAuthority: { resolve: async () => null } },
      ]),
    ).toThrow("Channels reconciliation requires the typed Inventory channelSaleRecorder host port.");
  });

  it("withholding storage authority from a constructed Channels service gives binding-not-current and zero events", async () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("no Inventory pool");
    };
    const composed = channelsModule.createServices(
      { query: unavailable, connect: unavailable },
      { channelSaleRecorder: unavailable },
    );
    expect(
      await composed.storageLocationAuthority.resolve({ accountId: "acc_owner", storageLocationId: "location_1" }),
    ).toBeNull();
    const harness = createConnectionHarness({
      setupResolver: channelProviderRegistry.setupResolver,
      storageLocationAuthority: composed.storageLocationAuthority,
    });
    await harness.services.connectChannel(
      { accountId: "acc_owner", connectionId: "connection", providerKey: "tcgplayer" },
      { deploymentEnvironment: "test" },
      testContext,
    );
    await expect(
      harness.services.activateChannelConnection(
        {
          accountId: "acc_owner",
          connectionId: "connection",
          bindings: [{ storageLocationId: "location_1", revision: 1 }],
        },
        testContext,
      ),
    ).rejects.toMatchObject({ code: "binding-not-current" });
    expect(harness.memory.streams.get("channels.connection-connection")).toHaveLength(1);
  });

  it("keeps an Inventory read failure unavailable for activation and resume callers", async () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("unavailable");
    };
    const composed = channelsModule.createServices(
      { query: unavailable, connect: unavailable },
      {
        channelSaleRecorder: unavailable,
        storageLocationAuthority: { resolve: unavailable },
      },
    );
    expect(
      await composed.storageLocationAuthority.resolve({ accountId: "acc_owner", storageLocationId: "location_1" }),
    ).toBeNull();
  });
});
