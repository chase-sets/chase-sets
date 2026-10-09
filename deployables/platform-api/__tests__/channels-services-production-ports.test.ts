import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import { createStorageLocationAuthority } from "@chase-sets/inventory/server";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { isChannelsServices } from "@chase-sets/channels/server";
import { module as channelsModule } from "@chase-sets/channels";
import { createPlatformApiHost } from "../src/app";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import { workerContextRegistry } from "../../platform-worker/src/generated/worker-context-registry";
import { createPlatformChannelSaleRecorder } from "../../platform-worker/src/channels-reconciliation-runners";
import {
  createFakePaymentProcessorGateway,
  createFakeMoneyMovementGateway,
  createSandboxPostageLabelProvider,
} from "../../platform-worker/src/test-support/provider-gateways";

const stores = vi.hoisted(() => ({ current: undefined as unknown }));
const testContext: EventStoreContext = {
  tenantId: "tnt_channels_composition" as TenantId,
  audit: { performedByUserId: "usr_channels_composition" as UserId, forAccountId: "acc_owner" as AccountId },
};
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
  createPostgresEventStore: () => stores.current,
}));

describe("channels-services-production-ports", () => {
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
      const app = new Hono<{
        Variables: { actor: { accountId: string; permissions: string[] }; context: EventStoreContext };
      }>();
      app.use("*", async (c, next) => {
        c.set("actor", { accountId: "acc_owner", permissions: ["channels.view", "channels.manage"] });
        c.set("context", testContext);
        await next();
      });
      const [api] = channelsModule.buildApis(services);
      if (!(api.router instanceof Hono)) throw new Error("Channels API must compose a Hono router");
      app.route(api.mountPath, api.router);
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
});
