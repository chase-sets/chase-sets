import { describe, expect, it, vi } from "vitest";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import {
  buildEventReactionsFromManifest,
  buildEventSubscriptionsFromManifest,
  defineEventReactionHandlers,
  defineEventSubscriptionHandlers,
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
  anonymousRoutes: [
    {
      routePath: "/api/inventory/public",
      methods: ["GET"],
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
      batchSize: 25,
      checkpointBatchSize: 1,
      projectionTransactionTimeoutMs: 120_000,
      projectionStatementTimeoutMs: 120_000,
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
  eventReactions: [
    {
      sourceContextName: "ordering",
      reactionName: "inventory-order-reservation-workflow",
      subscriptionVersion: 1,
      reactionHandlerSetNames: ["inventory-order-reservation-workflow"],
      eventTypes: ["ordering.order.created"],
      idempotencyPolicy: "idempotent-command-dispatch",
      retryPolicy: "retry-from-last-checkpoint",
      failurePolicy: "surface-as-reaction-failure",
      order: 20,
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
        handlerKind: "projection",
        sourceContextName: "catalog",
        projectionName: "inventory-catalog-item-projection",
        subscriptionVersion: 2,
        handlers: {
          "catalog.catalog-item.published": handler,
        },
        eventTypes: ["catalog.catalog-item.published"],
        streamPrefixes: ["catalog.item-"],
        errorPolicy: undefined,
        batchSize: 25,
        checkpointBatchSize: 1,
        projectionTransactionTimeoutMs: 120_000,
        projectionStatementTimeoutMs: 120_000,
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

  it("contextually types payloads in typed handler maps", () => {
    type CatalogEventPayloads = Readonly<{
      "catalog.catalog-item.published": Readonly<{
        itemId: string;
      }>;
    }>;

    const handlers = defineEventSubscriptionHandlers<CatalogEventPayloads>({
      "catalog.catalog-item.published": async (event) => {
        expect(event.data.itemId).toBe("cat_1");
        // @ts-expect-error typed subscription payloads reject fields not published by the event contract.
        expect(event.data.itemName).toBeUndefined();
      },
    });

    const [subscription] = buildEventSubscriptionsFromManifest({
      contextName: "inventory",
      manifest,
      handlers: {
        "catalog.inventory-catalog-item-projection": () => handlers,
      },
    });

    expect(subscription?.handlers["catalog.catalog-item.published"]).toBe(handlers["catalog.catalog-item.published"]);
  });
});

describe("buildEventReactionsFromManifest", () => {
  it("copies reaction semantics and registers reaction-kind subscriptions", () => {
    const handler = vi.fn(async () => undefined);
    const reactions = buildEventReactionsFromManifest({
      contextName: "inventory",
      manifest,
      handlers: {
        "ordering.inventory-order-reservation-workflow": () =>
          defineEventReactionHandlers({
            "ordering.order.created": handler,
          }),
      },
    });

    expect(reactions).toEqual([
      {
        subscriptionName: "inventory.order-reservation-workflow",
        handlerKind: "reaction",
        sourceContextName: "ordering",
        projectionName: "inventory-order-reservation-workflow",
        reactionName: "inventory-order-reservation-workflow",
        subscriptionVersion: 1,
        handlers: {
          "ordering.order.created": handler,
        },
        idempotencyPolicy: "idempotent-command-dispatch",
        retryPolicy: "retry-from-last-checkpoint",
        failurePolicy: "surface-as-reaction-failure",
        eventTypes: ["ordering.order.created"],
        streamPrefixes: undefined,
        errorPolicy: undefined,
        order: 20,
      },
    ]);
  });

  it("uses one canonical missing reaction declaration error", () => {
    expect(() =>
      buildEventReactionsFromManifest({
        contextName: "inventory",
        manifest,
        handlers: {
          "ordering.inventory-missing-reaction": () => ({}),
        },
      }),
    ).toThrow(
      "Context 'inventory' is missing an eventReactions declaration for 'ordering' -> 'inventory-missing-reaction'.",
    );
  });
});

describe("defineBoundedContextModule", () => {
  it("derives manifest-owned module fields and keeps supplied wiring", async () => {
    const services = { db: "db" };
    const module = defineBoundedContextModule({
      manifest,
      schemaSql: "select 1;",
      schemaMigrations: [
        {
          migrationId: "20260703_example_index",
          description: "Create example index concurrently.",
          statements: ["CREATE INDEX CONCURRENTLY IF NOT EXISTS example_pages_id_idx ON example_pages (id);"],
        },
      ],
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
      schemaMigrations: [
        expect.objectContaining({
          migrationId: "20260703_example_index",
          statements: ["CREATE INDEX CONCURRENTLY IF NOT EXISTS example_pages_id_idx ON example_pages (id);"],
        }),
      ],
      apiMounts: manifest.apiMounts,
      anonymousRoutes: manifest.anonymousRoutes,
      projectionGroups: manifest.projectionGroups,
      seedProfiles: ["scenario-seed"],
    });
    expect(module.createServices({}, undefined)).toBe(services);
    expect(module.buildApis(services)).toEqual(["api:db"]);
    await expect(module.seed?.({}, services, { enabledDataProfiles: ["scenario-seed"] })).resolves.toBeUndefined();
  });
});
