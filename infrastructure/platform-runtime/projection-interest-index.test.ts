import { createResolvedApiMount, type ContextProjectionGroup } from "@chase-sets/bounded-context-runtime";
import { describe, expect, it } from "vitest";

import {
  buildProjectionInterestIndex,
  createProjectionInterestIndexCache,
  createProjectionWakeIntentInputs,
  createRouteProjectionWakeIntentInputs,
  lookupProjectionInterests,
  lookupRouteProjectionInterests,
  ProjectionInterestIndexStaleError,
  summarizeProjectionInterestIndex,
} from "./projection-interest-index";

const GENERATED_AT = new Date("2026-06-10T12:00:00.000Z");

describe("projection interest index", () => {
  it("maps source events to the minimal interested projection checkpoints", () => {
    const index = buildProjectionInterestIndex({
      generatedAt: GENERATED_AT,
      projectionGroups: [
        projectionGroup({
          targetContextName: "checkout",
          projectionName: "checkout-session-pages",
          ownedTables: ["checkout_session_pages"],
          runners: [
            runner({
              sourceContextName: "catalog",
              targetContextName: "checkout",
              projectionName: "checkout-session-pages",
              eventTypes: ["CatalogItemCheckoutProjectionUpserted"],
              streamPrefixes: ["catalog.items."],
            }),
          ],
        }),
        projectionGroup({
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-pages",
          ownedTables: ["marketplace_listing_pages"],
          runners: [
            runner({
              sourceContextName: "catalog",
              targetContextName: "marketplace",
              projectionName: "marketplace-listing-pages",
              eventTypes: ["CatalogListingProjectionUpserted"],
              streamPrefixes: ["catalog.listings."],
            }),
          ],
        }),
      ],
    });

    expect(
      lookupProjectionInterests(index, {
        sourceContextName: "catalog",
        eventType: "CatalogItemCheckoutProjectionUpserted",
        streamId: "catalog.items.card_1",
      }).map((entry) => entry.checkpointKey),
    ).toEqual(["checkout-session-pages:catalog:v1"]);

    expect(
      lookupProjectionInterests(index, {
        sourceContextName: "catalog",
        eventType: "CatalogItemCheckoutProjectionUpserted",
        streamId: "catalog.listings.lst_1",
      }),
    ).toEqual([]);
  });

  it("creates source-scoped wake intents for relay-originated commits", () => {
    const index = buildProjectionInterestIndex({
      generatedAt: GENERATED_AT,
      projectionGroups: [
        projectionGroup({
          targetContextName: "checkout",
          projectionName: "checkout-session-pages",
          ownedTables: ["checkout_session_pages"],
          runners: [
            runner({
              sourceContextName: "catalog",
              targetContextName: "checkout",
              projectionName: "checkout-session-pages",
              eventTypes: ["CatalogItemCheckoutProjectionUpserted"],
            }),
          ],
        }),
      ],
    });

    const intents = createProjectionWakeIntentInputs(index, {
      sourceContextName: "catalog",
      eventType: "CatalogItemCheckoutProjectionUpserted",
      requiredPosition: "42",
      requiredCursor: "catalog:42",
      correlationId: "corr_checkout",
      metadata: { sourceCommitId: "commit_1" },
    });

    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      sourceContextName: "catalog",
      targetContextName: "checkout",
      projectionName: "checkout-session-pages",
      checkpointKey: "checkout-session-pages:catalog:v1",
      requiredPosition: "42",
      requiredCursor: "catalog:42",
      priorityLane: "standard",
      origin: "relay",
      correlationId: "corr_checkout",
      schemaVersion: 1,
      payloadVersion: 1,
    });
    expect(intents[0].metadata).toMatchObject({
      sourceCommitId: "commit_1",
      projectionInterestIndexVersion: index.indexVersion,
    });
  });

  it("maps route read-model dependencies through resolved API mounts", () => {
    const group = projectionGroup({
      targetContextName: "checkout",
      projectionName: "checkout-session-pages",
      ownedTables: ["checkout_session_pages"],
      runners: [
        runner({
          sourceContextName: "catalog",
          targetContextName: "checkout",
          projectionName: "checkout-session-pages",
          eventTypes: ["CatalogItemCheckoutProjectionUpserted"],
        }),
        runner({
          sourceContextName: "payments",
          targetContextName: "checkout",
          projectionName: "checkout-session-pages",
          eventTypes: ["PaymentAuthorized"],
        }),
      ],
    });
    const apiMount = createResolvedApiMount(
      "checkout",
      {
        mountPath: "/api/checkout",
        kind: "primary",
        requiresAuth: false,
        readFreshnessRoutes: [
          {
            routePath: "/account/checkout-sessions/:sessionId",
            dependencies: [{ readModelTable: "checkout_session_pages" }],
          },
        ],
      },
      {},
    );
    const index = buildProjectionInterestIndex({
      generatedAt: GENERATED_AT,
      projectionGroups: [group],
      apiMounts: [apiMount],
    });

    expect(apiMount.readFreshnessRoutes).toHaveLength(1);
    expect(
      lookupRouteProjectionInterests(index, {
        mountPath: "/api/checkout",
        path: "/api/checkout/account/checkout-sessions/chk_1",
        method: "GET",
      }).map((entry) => `${entry.sourceContextName}:${entry.checkpointKey}:${entry.priorityLane}`),
    ).toEqual(["catalog:checkout-session-pages:catalog:v1:hot", "payments:checkout-session-pages:payments:v1:hot"]);

    expect(
      createRouteProjectionWakeIntentInputs(index, {
        mountPath: "/api/checkout",
        routePath: "/account/checkout-sessions/:sessionId",
        sourcePositions: [
          { sourceContextName: "catalog", requiredPosition: 12, requiredCursor: "catalog:12" },
          { sourceContextName: "payments", requiredPosition: 4, requiredCursor: "payments:4" },
        ],
        correlationId: "corr_route",
      }).map((intent) => ({
        sourceContextName: intent.sourceContextName,
        requiredPosition: intent.requiredPosition,
        requiredCursor: intent.requiredCursor,
        origin: intent.origin,
        priorityLane: intent.priorityLane,
      })),
    ).toEqual([
      {
        sourceContextName: "catalog",
        requiredPosition: 12,
        requiredCursor: "catalog:12",
        origin: "api-wait",
        priorityLane: "hot",
      },
      {
        sourceContextName: "payments",
        requiredPosition: 4,
        requiredCursor: "payments:4",
        origin: "api-wait",
        priorityLane: "hot",
      },
    ]);
  });

  it("maps explicit multi-projection route dependencies for exception reads", () => {
    const index = buildProjectionInterestIndex({
      generatedAt: GENERATED_AT,
      projectionGroups: [
        projectionGroup({
          targetContextName: "ordering",
          projectionName: "ordering-order-projection",
          ownedTables: ["ordering_order_pages"],
          runners: [
            runner({
              sourceContextName: "ordering",
              targetContextName: "ordering",
              projectionName: "ordering-order-projection",
            }),
          ],
        }),
        projectionGroup({
          targetContextName: "ordering",
          projectionName: "ordering-marketplace-offer-acceptance",
          ownedTables: ["ordering_offer_acceptance_inputs"],
          runners: [
            runner({
              sourceContextName: "marketplace",
              targetContextName: "ordering",
              projectionName: "ordering-marketplace-offer-acceptance",
            }),
          ],
        }),
      ],
      apiMounts: [
        createResolvedApiMount(
          "ordering",
          {
            mountPath: "/api/marketplace",
            kind: "primary",
            requiresAuth: true,
            readFreshnessRoutes: [
              {
                routePath: "/sales",
                dependencies: [
                  { projectionName: "ordering-order-projection" },
                  { projectionName: "ordering-marketplace-offer-acceptance" },
                ],
              },
            ],
          },
          {},
        ),
      ],
    });

    expect(
      lookupRouteProjectionInterests(index, {
        mountPath: "/api/marketplace",
        path: "/api/marketplace/sales",
        method: "GET",
      }).map((entry) => `${entry.sourceContextName}:${entry.projectionName}`),
    ).toEqual(["marketplace:ordering-marketplace-offer-acceptance", "ordering:ordering-order-projection"]);
  });

  it("fails closed when a route read-model table has ambiguous projection ownership", () => {
    expect(() =>
      buildProjectionInterestIndex({
        generatedAt: GENERATED_AT,
        projectionGroups: [
          projectionGroup({
            targetContextName: "checkout",
            projectionName: "checkout-session-pages",
            ownedTables: ["checkout_session_pages"],
            runners: [
              runner({
                sourceContextName: "checkout",
                targetContextName: "checkout",
                projectionName: "checkout-session-pages",
              }),
            ],
          }),
          projectionGroup({
            targetContextName: "checkout",
            projectionName: "checkout-session-audit-pages",
            ownedTables: ["checkout_session_pages"],
            runners: [
              runner({
                sourceContextName: "checkout",
                targetContextName: "checkout",
                projectionName: "checkout-session-audit-pages",
              }),
            ],
          }),
        ],
        apiMounts: [
          createResolvedApiMount(
            "checkout",
            {
              mountPath: "/api/checkout",
              kind: "primary",
              requiresAuth: false,
              readFreshnessRoutes: [
                {
                  routePath: "/account/checkout-sessions/:sessionId",
                  dependencies: [{ readModelTable: "checkout_session_pages" }],
                },
              ],
            },
            {},
          ),
        ],
      }),
    ).toThrow(
      "Read freshness dependency table 'checkout.checkout_session_pages' is owned by multiple mounted projection groups: checkout-session-pages, checkout-session-audit-pages.",
    );
  });

  it("keeps projection opt-outs observable while excluding them from default lookups", () => {
    const index = buildProjectionInterestIndex({
      generatedAt: GENERATED_AT,
      projectionGroups: [
        projectionGroup({
          targetContextName: "checkout",
          projectionName: "checkout-session-pages",
          ownedTables: ["checkout_session_pages"],
          runners: [
            runner({
              sourceContextName: "catalog",
              targetContextName: "checkout",
              projectionName: "checkout-session-pages",
              eventTypes: ["CatalogItemCheckoutProjectionUpserted"],
            }),
          ],
        }),
      ],
      projectionOverrides: [
        {
          sourceContextName: "catalog",
          targetContextName: "checkout",
          projectionName: "checkout-session-pages",
          owner: "Checkout",
          disabled: true,
          optOutReason: "deferred until source-context registry wave 2",
        },
      ],
    });

    expect(
      lookupProjectionInterests(index, {
        sourceContextName: "catalog",
        eventType: "CatalogItemCheckoutProjectionUpserted",
      }),
    ).toEqual([]);

    expect(
      lookupProjectionInterests(index, {
        sourceContextName: "catalog",
        eventType: "CatalogItemCheckoutProjectionUpserted",
        includeDisabled: true,
      }),
    ).toMatchObject([
      {
        owner: "Checkout",
        enabled: false,
        optOutReason: "deferred until source-context registry wave 2",
      },
    ]);

    expect(summarizeProjectionInterestIndex(index)).toMatchObject({
      entryCount: 1,
      enabledEntryCount: 0,
      disabledEntryCount: 1,
      enabledSourceContextNames: [],
    });
  });

  it("fails closed for stale snapshots and reloads through the cache", async () => {
    let version = 1;
    const cache = createProjectionInterestIndexCache(() =>
      buildProjectionInterestIndex({
        indexVersion: `projection-index-v${version++}`,
        generatedAt: GENERATED_AT,
        projectionGroups: [
          projectionGroup({
            targetContextName: "checkout",
            projectionName: "checkout-session-pages",
            ownedTables: ["checkout_session_pages"],
            runners: [
              runner({
                sourceContextName: "catalog",
                targetContextName: "checkout",
                projectionName: "checkout-session-pages",
                eventTypes: ["CatalogItemCheckoutProjectionUpserted"],
              }),
            ],
          }),
        ],
      }),
    );

    const first = await cache.reload();
    expect(first.indexVersion).toBe("projection-index-v1");
    cache.markStale("runtime module reload requested");

    expect(() =>
      lookupProjectionInterests(cache.requireSnapshot({ allowStale: true }), {
        sourceContextName: "catalog",
        eventType: "CatalogItemCheckoutProjectionUpserted",
        allowStale: true,
      }),
    ).not.toThrow();
    expect(() =>
      lookupProjectionInterests(cache.requireSnapshot(), {
        sourceContextName: "catalog",
        eventType: "CatalogItemCheckoutProjectionUpserted",
      }),
    ).toThrow(ProjectionInterestIndexStaleError);

    const second = await cache.reload();
    expect(second.indexVersion).toBe("projection-index-v2");
    expect(second.status).toBe("active");
  });
});

function projectionGroup(
  input: Readonly<{
    targetContextName: string;
    projectionName: string;
    ownedTables: readonly string[];
    runners: readonly ReturnType<typeof runner>[];
  }>,
): ContextProjectionGroup {
  return {
    projectionName: input.projectionName,
    projectionRevision: 1,
    targetContextName: input.targetContextName,
    sourceContextNames: input.runners.map((entry) => entry.sourceContextName),
    ownedTables: input.ownedTables,
    requiredDuringBootstrap: false,
    subscriptionRunners: input.runners,
    reset: async () => {},
    getStatus: () => ({}) as never,
    refreshStatus: async () => ({}) as never,
    markRevisionSynced: async () => {},
  };
}

function runner(
  input: Readonly<{
    sourceContextName: string;
    targetContextName: string;
    projectionName: string;
    eventTypes?: readonly string[];
    streamPrefixes?: readonly string[];
  }>,
) {
  return {
    subscriptionName: `${input.targetContextName}.${input.projectionName}.${input.sourceContextName}`,
    projectionName: input.projectionName,
    sourceContextName: input.sourceContextName,
    targetContextName: input.targetContextName,
    subscriptionVersion: 1,
    checkpointKey: `${input.projectionName}:${input.sourceContextName}:v1`,
    eventTypes: input.eventTypes,
    streamPrefixes: input.streamPrefixes,
    order: 0,
    runOnce: async () => ({}) as never,
    getStatus: () => ({}) as never,
    refreshStatus: async () => ({}) as never,
    reset: async () => {},
    retryBlockedStream: async () => ({}) as never,
  };
}
