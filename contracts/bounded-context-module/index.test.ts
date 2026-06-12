import { describe, expect, it, vi } from "vitest";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import {
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
  type BcEventSubscriptionHandler,
} from "./index";

const manifest: BcContextManifest = {
  contextName: "inventory",
  apiBasePath: "/api/inventory",
  streamPrefix: "inventory.",
  apiMounts: [
    {
      mountPath: "/api/inventory",
      kind: "primary",
      requiresAuth: true,
    },
  ],
  eventSubscriptions: [
    {
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 2,
      projectionHandlerSetNames: ["inventory-catalog-item-projection"],
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
      order: 10,
    },
  ],
  projectionGroups: [
    {
      projectionName: "inventory-catalog-item-projection",
      sourceContextNames: ["catalog"],
      ownedTables: ["inventory_catalog_items"],
      requiredDuringBootstrap: true,
      resetStrategy: "replay-only",
    },
  ],
};

describe("buildEventSubscriptionsFromManifest", () => {
  it("copies manifest declaration fields and attaches handlers", () => {
    const handler = vi.fn(async () => undefined);
    const subscriptions = buildEventSubscriptionsFromManifest({
      contextName: "inventory",
      manifest,
      handlers: {
        "catalog.inventory-catalog-item-projection": () => ({
          "catalog.catalog-item.published": handler,
        }),
      },
    });

    expect(subscriptions).toEqual([
      {
        subscriptionName: "inventory.catalog-item-projection",
        sourceContextName: "catalog",
        projectionName: "inventory-catalog-item-projection",
        subscriptionVersion: 2,
        handlers: {
          "catalog.catalog-item.published": handler,
        },
        eventTypes: ["catalog.catalog-item.published"],
        streamPrefixes: ["catalog.item-"],
        errorPolicy: undefined,
        order: 10,
      },
    ]);
  });

  it("uses one canonical missing declaration error", () => {
    expect(() =>
      buildEventSubscriptionsFromManifest({
        contextName: "inventory",
        manifest,
        handlers: {
          "catalog.inventory-missing-projection": () => ({}),
        },
      }),
    ).toThrow(
      "Context 'inventory' is missing an eventSubscriptions declaration for 'catalog' -> 'inventory-missing-projection'.",
    );
  });

  it("can filter shared handler maps to a subscription declaration's eventTypes", () => {
    const sharedHandlers: ProjectorHandlerMap = {
      "catalog.catalog-item.published": async () => undefined,
      "catalog.catalog-item.retired": async () => undefined,
    };

    const [subscription] = buildEventSubscriptionsFromManifest({
      contextName: "inventory",
      manifest,
      handlers: {
        "catalog.inventory-catalog-item-projection": {
          subscriptionName: "inventory.catalog-item-projection",
          filterToEventTypes: true,
          buildHandlers: () => sharedHandlers,
        },
      },
    });

    expect(Object.keys(subscription?.handlers ?? {})).toEqual(["catalog.catalog-item.published"]);
  });

  it("accepts payload-specific handler maps for future typed subscription declarations", () => {
    type CatalogPublishedPayload = Readonly<{
      itemId: string;
    }>;

    const handler: BcEventSubscriptionHandler<CatalogPublishedPayload> = async (event) => {
      expect(event.data.itemId).toBe("cat_1");
    };

    const [subscription] = buildEventSubscriptionsFromManifest({
      contextName: "inventory",
      manifest,
      handlers: {
        "catalog.inventory-catalog-item-projection": () => ({
          "catalog.catalog-item.published": handler,
        }),
      },
    });

    expect(subscription?.handlers["catalog.catalog-item.published"]).toBe(handler);
  });
});

describe("defineBoundedContextModule", () => {
  it("derives manifest-owned module fields and keeps supplied wiring", async () => {
    const services = { db: "db" };
    const module = defineBoundedContextModule({
      manifest,
      schemaSql: "select 1;",
      createServices: () => services,
      buildApis: (createdServices) => [`api:${createdServices.db}`],
      projectionHandlerSets: () => [],
      seedProfiles: ["scenario-seed"],
      seed: async () => undefined,
    });

    expect(module).toMatchObject({
      contextName: "inventory",
      routePrefix: "/api/inventory",
      streamPrefix: "inventory.",
      schemaSql: "select 1;",
      apiMounts: manifest.apiMounts,
      projectionGroups: manifest.projectionGroups,
      seedProfiles: ["scenario-seed"],
    });
    expect(module.createServices({}, undefined)).toBe(services);
    expect(module.buildApis(services)).toEqual(["api:db"]);
    await expect(module.seed?.({}, services, { enabledDataProfiles: ["scenario-seed"] })).resolves.toBeUndefined();
  });
});
