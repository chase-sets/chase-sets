import { describe, expect, it, vi } from "vitest";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import {
  buildEventReactionsFromManifest,
  buildEventSubscriptionsFromManifest,
  defineBoundedContextManifest,
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
  mcpCapabilities: {
    tools: [{ name: "inventory.list-import-sources", ownerSlice: "import-batches" }],
    resources: [
      {
        uriTemplate: "chase-sets://inventory/{accountId}/import-batches/{batchId}",
        ownerSlice: "import-batches",
      },
    ],
  },
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
      sourceContextMount: "when-mounted",
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

  it("normalizes JSON-imported source context mount gating", () => {
    const sourceContextMount = "when-all-sources-mounted" as string;
    const handler = vi.fn(async () => undefined);
    const [subscription] = buildEventSubscriptionsFromManifest({
      contextName: "inventory",
      manifest: {
        eventSubscriptions: [
          {
            sourceContextName: "catalog",
            sourceContextMount,
            projectionName: "inventory-catalog-item-projection",
            subscriptionVersion: 2,
            projectionHandlerSetNames: ["inventory-catalog-item-projection"],
            eventTypes: ["catalog.catalog-item.published"],
          },
        ],
      },
      handlers: {
        "catalog.inventory-catalog-item-projection": () => ({
          "catalog.catalog-item.published": handler,
        }),
      },
    });

    expect(subscription).toMatchObject({
      sourceContextName: "catalog",
      sourceContextMount: "when-all-sources-mounted",
      projectionName: "inventory-catalog-item-projection",
    });
  });

  it("rejects unsupported JSON-imported source context mount gating", () => {
    expect(() =>
      buildEventSubscriptionsFromManifest({
        contextName: "inventory",
        manifest: {
          eventSubscriptions: [
            {
              sourceContextName: "catalog",
              sourceContextMount: "after-first-source" as string,
              projectionName: "inventory-catalog-item-projection",
              subscriptionVersion: 2,
              projectionHandlerSetNames: ["inventory-catalog-item-projection"],
            },
          ],
        },
        handlers: {
          "catalog.inventory-catalog-item-projection": () => ({}),
        },
      }),
    ).toThrow(
      "Context 'inventory' projection 'inventory-catalog-item-projection' declares unsupported sourceContextMount 'after-first-source'.",
    );
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
        sourceContextMount: "when-mounted",
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
  it("normalizes JSON-imported projection group gates and runtime profiles", () => {
    const sourceContextMount = "when-all-sources-mounted" as string;
    const resetStrategy = "append-only-no-reset" as string;
    const apiRuntimeProfile = "landing" as string;
    const workerRuntimeProfile = "public" as string;

    const normalizedManifest = defineBoundedContextManifest({
      contextName: "inventory",
      apiBasePath: "/api/inventory",
      streamPrefix: "inventory.",
      projectionGroups: [
        {
          projectionName: "inventory-catalog-item-projection",
          sourceContextNames: ["catalog", "marketplace"],
          sourceContextMount,
          ownedTables: ["inventory_catalog_items"],
          resetStrategy,
        },
      ],
      apiRuntimeProfiles: [apiRuntimeProfile],
      workerRuntimeProfiles: [workerRuntimeProfile],
    });

    expect(normalizedManifest.projectionGroups).toEqual([
      {
        projectionName: "inventory-catalog-item-projection",
        sourceContextNames: ["catalog", "marketplace"],
        sourceContextMount: "when-all-sources-mounted",
        ownedTables: ["inventory_catalog_items"],
        resetStrategy: "append-only-no-reset",
      },
    ]);
    expect(normalizedManifest.apiRuntimeProfiles).toEqual(["landing"]);
    expect(normalizedManifest.workerRuntimeProfiles).toEqual(["public"]);
  });

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
      buildMcpHandlers: () => ({
        toolHandlers: {
          "inventory.list-import-sources": () => ({ items: [], total: 0 }),
        },
      }),
      projectionHandlerSets: () => [],
      seedProfiles: ["scenario-seed"],
      seed: async () => undefined,
      reconcileBootstrapState: async () => undefined,
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
      mcpCapabilities: manifest.mcpCapabilities,
      eventSubscriptions: manifest.eventSubscriptions,
      eventReactions: manifest.eventReactions,
      projectionGroups: manifest.projectionGroups,
      seedProfiles: ["scenario-seed"],
    });
    expect(module.createServices({}, undefined)).toBe(services);
    expect(module.buildApis(services)).toEqual(["api:db"]);
    expect(module.buildMcpHandlers?.(services).toolHandlers?.["inventory.list-import-sources"]).toEqual(
      expect.any(Function),
    );
    await expect(module.seed?.({}, services, { enabledDataProfiles: ["scenario-seed"] })).resolves.toBeUndefined();
    await expect(
      module.reconcileBootstrapState?.({}, services, { enabledDataProfiles: ["critical-bootstrap"] }),
    ).resolves.toBeUndefined();
  });

  it("forwards normalized event subscription and reaction declarations", () => {
    const sourceContextMount = "when-all-sources-mounted" as string;
    const module = defineBoundedContextModule({
      manifest: {
        contextName: "inventory",
        apiBasePath: "/api/inventory",
        streamPrefix: "inventory.",
        eventSubscriptions: [
          {
            sourceContextName: "catalog",
            sourceContextMount,
            projectionName: "inventory-catalog-item-projection",
            subscriptionVersion: 2,
            projectionHandlerSetNames: ["inventory-catalog-item-projection"],
          },
        ],
        eventReactions: [
          {
            sourceContextName: "ordering",
            sourceContextMount,
            reactionName: "inventory-order-reservation-workflow",
            subscriptionVersion: 1,
            reactionHandlerSetNames: ["inventory-order-reservation-workflow"],
            idempotencyPolicy: "idempotent-command-dispatch",
            retryPolicy: "retry-from-last-checkpoint",
            failurePolicy: "surface-as-reaction-failure",
          },
        ],
      },
      schemaSql: "",
      createServices: () => ({}),
      buildApis: () => [],
    });

    expect(module.eventSubscriptions).toEqual([
      expect.objectContaining({
        sourceContextName: "catalog",
        sourceContextMount: "when-all-sources-mounted",
        projectionName: "inventory-catalog-item-projection",
      }),
    ]);
    expect(module.eventReactions).toEqual([
      expect.objectContaining({
        sourceContextName: "ordering",
        sourceContextMount: "when-all-sources-mounted",
        reactionName: "inventory-order-reservation-workflow",
      }),
    ]);
  });

  it("omits event declaration surfaces when the manifest omits them", () => {
    const module = defineBoundedContextModule({
      manifest: {
        contextName: "inventory",
        apiBasePath: "/api/inventory",
        streamPrefix: "inventory.",
      },
      schemaSql: "",
      createServices: () => ({}),
      buildApis: () => [],
    });

    expect(module).not.toHaveProperty("eventSubscriptions");
    expect(module).not.toHaveProperty("eventReactions");
  });
});
