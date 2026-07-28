import { describe, expect, it, vi } from "vitest";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { OrderingServices } from "../support/runtime-support/services";

const capturedHandlerMaps = vi.hoisted(() => ({
  marketplaceSupply: [] as ProjectorHandlerMap[],
  reputation: [] as ProjectorHandlerMap[],
  moneyTimeline: [] as ProjectorHandlerMap[],
}));

vi.mock("../features/orders/integrations/supply/supply-projection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features/orders/integrations/supply/supply-projection")>();

  return {
    ...actual,
    buildOrderingMarketplaceSupplyProjectionHandlers: (
      ...args: Parameters<typeof actual.buildOrderingMarketplaceSupplyProjectionHandlers>
    ) => {
      const handlers = actual.buildOrderingMarketplaceSupplyProjectionHandlers(...args);
      if ("onSellerOrderCapacityChanged" in (args[1] ?? {})) {
        capturedHandlerMaps.marketplaceSupply.push(handlers);
      }
      return handlers;
    },
  };
});

vi.mock("../features/orders/integrations/reputation/reputation-projection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../features/orders/integrations/reputation/reputation-projection")>();

  return {
    ...actual,
    buildOrderingReputationProjectionHandlers: (
      ...args: Parameters<typeof actual.buildOrderingReputationProjectionHandlers>
    ) => {
      const handlers = actual.buildOrderingReputationProjectionHandlers(...args);
      capturedHandlerMaps.reputation.push(handlers);
      return handlers;
    },
  };
});

vi.mock("../features/orders/integrations/money-timeline/money-timeline-projection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../features/orders/integrations/money-timeline/money-timeline-projection")>();

  return {
    ...actual,
    buildOrderingMoneyTimelineProjectionHandlers: (
      ...args: Parameters<typeof actual.buildOrderingMoneyTimelineProjectionHandlers>
    ) => {
      const handlers = actual.buildOrderingMoneyTimelineProjectionHandlers(...args);
      capturedHandlerMaps.moneyTimeline.push(handlers);
      return handlers;
    },
  };
});

import { module as orderingModule } from "../index";

describe("ordering subscription handler sharing", () => {
  it("preserves one hoisted handler-map instance behind each fan-in group", () => {
    const subscriptions = orderingModule.buildSubscriptions?.(createServices()) ?? [];

    expect(capturedHandlerMaps.marketplaceSupply).toHaveLength(1);
    expect(capturedHandlerMaps.reputation).toHaveLength(1);
    expect(capturedHandlerMaps.moneyTimeline).toHaveLength(1);
    expectFanInUsesHandlersFromOneMap(
      subscriptions,
      "ordering-marketplace-supply-input-projection",
      ["catalog", "marketplace"],
      capturedHandlerMaps.marketplaceSupply[0]!,
    );
    expectFanInUsesHandlersFromOneMap(
      subscriptions,
      "ordering-order-review-opportunity-projection",
      ["fulfillment", "marketplace", "ordering", "platform-operations"],
      capturedHandlerMaps.reputation[0]!,
    );
    expectFanInUsesHandlersFromOneMap(
      subscriptions,
      "ordering-order-money-timeline-projection",
      ["payments", "platform-operations", "settlement"],
      capturedHandlerMaps.moneyTimeline[0]!,
    );
  });
});

function expectFanInUsesHandlersFromOneMap(
  subscriptions: readonly Readonly<{
    projectionName: string;
    sourceContextName: string;
    handlers: ProjectorHandlerMap;
  }>[],
  projectionName: string,
  expectedSourceContextNames: readonly string[],
  sharedHandlers: ProjectorHandlerMap,
) {
  const fanIn = subscriptions.filter((subscription) => subscription.projectionName === projectionName);

  expect(fanIn.map((subscription) => subscription.sourceContextName).sort()).toEqual(
    [...expectedSourceContextNames].sort(),
  );
  for (const subscription of fanIn) {
    for (const [eventType, handler] of Object.entries(subscription.handlers)) {
      expect(handler).toBe(sharedHandlers[eventType]);
    }
  }
}

function createServices(): OrderingServices {
  return {
    db: { query: async () => ({ rows: [], rowCount: 0 }) },
    orders: {
      commandHandler: async () => undefined as never,
      reconcileSellerOrderCapacitySignal: async () => undefined,
    } as unknown as OrderingServices["orders"],
    postagePolicies: {} as OrderingServices["postagePolicies"],
    projectors: [],
    pool: {} as OrderingServices["pool"],
  };
}
