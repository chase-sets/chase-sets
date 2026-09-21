import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import { createStorageLocationAuthority } from "@chase-sets/inventory/server";
import { createNoopCommercialTermsResolver } from "../../../../commercial-terms/server";
import { createPlatformApiHost } from "../../../../../deployables/platform-api/src/app";
import { apiContextRegistry } from "../../../../../deployables/platform-api/src/generated/api-context-registry";
import { workerContextRegistry } from "../../../../../deployables/platform-worker/src/generated/worker-context-registry";
import { createPlatformChannelSaleRecorder } from "../../../../../deployables/platform-worker/src/channels-reconciliation-runners";
import {
  createFakePaymentProcessorGateway,
  createFakeMoneyMovementGateway,
  createSandboxPostageLabelProvider,
} from "../../../../../deployables/platform-worker/src/test-support/provider-gateways";
import { isChannelsServices } from "../../../server";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import { module as channelsModule } from "../../../index";
import { createConnectionHarness, testContext } from "./test-support";
import { channelProviderRegistry } from "../../publication-port/api/registry";

const root = path.resolve(import.meta.dirname, "../../../../..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

const stores = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
  createPostgresEventStore: () => stores.current,
}));

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

  it("the API host without an Inventory pool reaches the named Channels createServices guard", () => {
    stores.current = createInMemoryEventStore().eventStore;
    const unavailable = async (): Promise<never> => {
      throw new Error("composition must not query storage");
    };
    const pool = { query: unavailable, connect: unavailable };
    const pools = Object.fromEntries(
      apiContextRegistry.filter((entry) => entry.contextName !== "inventory").map((entry) => [entry.contextName, pool]),
    );
    const createServices = vi.spyOn(channelsModule, "createServices");
    expect(() =>
      createPlatformApiHost({
        pools,
        runtimeProfile: "public",
        hostPorts: { processorGateway: createFakePaymentProcessorGateway() },
      }),
    ).toThrow("Channels reconciliation requires the typed Inventory channelSaleRecorder host port.");
    expect(createServices).toHaveBeenCalled();
    createServices.mockRestore();
  });

  it.each(["platform-api", "platform-worker", "bootstrap"] as const)(
    "%s composes both real authorities and refuses unavailable storage with zero activation events",
    async (host) => {
      const memory = createInMemoryEventStore();
      stores.current = memory.eventStore;
      const query = vi.fn(async () => ({ rows: [] }));
      const pool = { query, connect: async () => ({ query, release: () => {} }) };
      const pools = Object.fromEntries(apiContextRegistry.map((entry) => [entry.contextName, pool]));
      const processorGateway = createFakePaymentProcessorGateway();
      const runtime =
        host === "platform-worker"
          ? createWorkerHost(workerContextRegistry, "platform-worker", {
              pools,
              runtimeProfile: "public",
              hostPorts: {
                processorGateway,
                moneyMovementGateway: createFakeMoneyMovementGateway(),
                operationsRecorder: { record: () => undefined },
                postageLabelProvider: createSandboxPostageLabelProvider(),
                inventoryCleanupAuthority: { kind: "not-mounted" },
                commercialTermsResolver: createNoopCommercialTermsResolver(),
                tcgplayerMarketTransport: { kind: "not-mounted" },
                tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
                channelConnectionIdentityReader: { resolve: async () => null },
                channelSaleRecorder: createPlatformChannelSaleRecorder(pool),
                storageLocationAuthority: {
                  resolve: createStorageLocationAuthority(pool).resolveStorageLocationAuthority,
                },
              },
            })
          : createPlatformApiHost({ pools, runtimeProfile: "public", hostPorts: { processorGateway } });
      const services = runtime.services.channels;
      if (!isChannelsServices(services)) throw new Error("Channels services missing from production registry");
      await memory.eventStore.appendToStream({
        streamId: "inventory.storage-location-location_1",
        expectedVersion: "no_stream",
        context: testContext,
        events: [
          {
            eventType: "inventory.storage-location.created",
            payload: {
              storageLocationId: "location_1",
              accountId: "acc_owner",
              name: "Shelf",
              description: null,
              shipFromCode: "shelf",
              shipFromAddress: null,
            },
          },
        ],
      });
      expect(
        await services.storageLocationAuthority.resolve({ accountId: "acc_owner", storageLocationId: "location_1" }),
      ).toEqual({
        accountId: "acc_owner",
        storageLocationId: "location_1",
        revision: 1,
        status: "active",
      });
      const app = new Hono<ChannelsApiEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", { accountId: "acc_owner", permissions: ["channels.view", "channels.manage"] });
        c.set("context", testContext);
        await next();
      });
      app.route(
        "/api/channels",
        buildChannelsApi(services, {
          deploymentEnvironment: "test",
          storageLocationAuthority: services.storageLocationAuthority,
        }),
      );
      const post = (url: string, body: unknown) =>
        app.request(`/api/channels/connections${url}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      for (const available of [true, false]) {
        const created = await post("", { providerKey: "tcgplayer" });
        expect(created.status).toBe(201);
        const connection = await created.json();
        const { connectionId } = connection;
        vi.spyOn(services.connections, "getConnection").mockResolvedValue(connection);
        if (!available) {
          const readStream = memory.eventStore.readStream.bind(memory.eventStore);
          vi.spyOn(memory.eventStore, "readStream").mockImplementation((input) => {
            if (input.streamId.startsWith("inventory.")) throw new Error("Inventory storage unavailable");
            return readStream(input);
          });
        }
        const activated = await post(`/${connectionId}/activate`, { storageLocationIds: ["location_1"] });
        expect(activated.status).toBe(available ? 200 : 409);
        if (available) {
          expect(await activated.json()).toMatchObject({ status: "active" });
          expect(query).toHaveBeenCalledWith(expect.stringContaining("platform_policy_documents"), expect.anything());
        } else {
          expect(await activated.json()).toMatchObject({ error: { code: "binding-not-current" } });
        }
        expect(memory.streams.get(`channels.connection-${connectionId}`)).toHaveLength(available ? 2 : 1);
      }
    },
  );

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
