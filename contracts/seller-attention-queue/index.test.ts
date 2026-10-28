import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aggregateSellerAttentionQueue,
  buildSellerAttentionItem,
  isSellerAttentionItem,
  resolveSellerAttentionDeepLink,
  type SellerAttentionSourceId,
  type SellerAttentionContext,
  type SellerAttentionItem,
  type SellerAttentionSource,
} from "./index";

const CONTEXT: SellerAttentionContext = { accountId: "acct-1", now: "2026-07-14T00:00:00.000Z" };

function shipByItem(overrides: Partial<SellerAttentionItem> = {}): SellerAttentionItem {
  return {
    ...buildSellerAttentionItem({
      source: "fulfillment-ship-by",
      entityId: "ship-1",
      severity: "critical",
      summary: { code: "ship-by-overdue", params: { reference: "SHP-1" } },
      observedAt: "2026-07-10T00:00:00.000Z",
      dueAt: "2026-07-11T00:00:00.000Z",
    }),
    ...overrides,
  };
}

function staticSource(id: SellerAttentionSource["id"], items: readonly SellerAttentionItem[]): SellerAttentionSource {
  return { id, load: async () => items };
}

describe("buildSellerAttentionItem", () => {
  it("derives a stable id, entity, and deep link from the blueprint source descriptor", () => {
    const item = shipByItem();
    expect(item.id).toBe("fulfillment-ship-by:ship-1");
    expect(item.entity).toBe("shipment");
    expect(item.deepLink).toEqual({ surface: "shipment", href: "/account/sales/shipments/ship-1" });
    expect(item.dueAt).toBe("2026-07-11T00:00:00.000Z");
  });

  it("defaults dueAt to null when the work has no clock", () => {
    const item = buildSellerAttentionItem({
      source: "settlement-blocked-payout",
      entityId: "pay-1",
      severity: "critical",
      summary: { code: "payout-blocked", params: {} },
      observedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(item.dueAt).toBeNull();
  });

  it("refuses a severity louder than the source's blueprint peak", () => {
    expect(() =>
      buildSellerAttentionItem({
        source: "listing-action",
        entityId: "list-1",
        severity: "critical",
        summary: { code: "listing-action", params: {} },
        observedAt: "2026-07-10T00:00:00.000Z",
      }),
    ).toThrow(/peak severity/);
  });
});

describe("resolveSellerAttentionDeepLink", () => {
  it.each([
    ["fulfillment-ship-by", "shipment", "/account/sales/shipments/entity%2Fwith%20space"],
    ["settlement-blocked-payout", "payout", "/account/desk/payouts/entity%2Fwith%20space"],
    ["dispute-response", "sale", "/account/sales/entity%2Fwith%20space"],
    [
      "inventory-resolution",
      "resolution-drawer",
      "/account/desk?drawer=resolution-drawer&entity=entity%2Fwith%20space",
    ],
    ["channel-action", "channel-connection", "/account/channels/entity%2Fwith%20space"],
    ["offer-response", "sell-list", "/account/desk/offers"],
    ["pricing-repricing", "repricing-policies", "/account/desk/repricing"],
    ["listing-action", "listing", "/account/listings/entity%2Fwith%20space"],
  ] satisfies ReadonlyArray<readonly [SellerAttentionSourceId, string, string]>)(
    "resolves %s to its registered owner route without changing the surface id",
    (source, surface, href) => {
      expect(resolveSellerAttentionDeepLink(source, "entity/with space")).toEqual({ surface, href });
    },
  );

  it("opens a drawer-target source over the Desk home rather than a route detour", () => {
    const link = resolveSellerAttentionDeepLink("inventory-resolution", "batch-9");
    expect(link.surface).toBe("resolution-drawer");
    expect(link.href).toBe("/account/desk?drawer=resolution-drawer&entity=batch-9");
  });

  it("keeps the three temporary destinations bound to tracked owner route declarations", () => {
    const routePaths = (manifestPath: string): string[] => {
      const manifest = JSON.parse(readFileSync(new URL(manifestPath, import.meta.url), "utf8")) as unknown;
      const paths: string[] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        if (value === null || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (key === "routePath" && typeof child === "string") paths.push(child);
          visit(child);
        }
      };
      visit(manifest);
      return paths;
    };

    expect(routePaths("../../bounded-contexts/marketplace/context.json")).toContain("/account/listings/:id");
    expect(routePaths("../../bounded-contexts/ordering/context.json")).toContain("/account/sales/:id");
    expect(routePaths("../../bounded-contexts/fulfillment/context.json")).toContain("/account/sales/shipments/:id");
  });
});

describe("isSellerAttentionItem", () => {
  it("accepts a well-formed item for its own source", () => {
    expect(isSellerAttentionItem(shipByItem(), "fulfillment-ship-by")).toBe(true);
  });

  it("rejects an item that claims another source's identity", () => {
    expect(isSellerAttentionItem(shipByItem(), "listing-action")).toBe(false);
  });

  it("rejects a bad timestamp", () => {
    expect(isSellerAttentionItem(shipByItem({ observedAt: "not-a-date" }), "fulfillment-ship-by")).toBe(false);
  });
});

describe("aggregateSellerAttentionQueue", () => {
  it("orders across sources by the blueprint policy (severity, then deadline, then source priority)", async () => {
    const blockedPayout = buildSellerAttentionItem({
      source: "settlement-blocked-payout",
      entityId: "pay-1",
      severity: "critical",
      summary: { code: "payout-blocked", params: {} },
      observedAt: "2026-07-01T00:00:00.000Z",
    });
    const overdueShipment = shipByItem();
    const staleListing = buildSellerAttentionItem({
      source: "listing-action",
      entityId: "list-1",
      severity: "info",
      summary: { code: "listing-action", params: {} },
      observedAt: "2026-07-01T00:00:00.000Z",
    });

    const queue = await aggregateSellerAttentionQueue(
      [
        staticSource("listing-action", [staleListing]),
        staticSource("settlement-blocked-payout", [blockedPayout]),
        staticSource("fulfillment-ship-by", [overdueShipment]),
      ],
      CONTEXT,
    );

    // Both critical, but the dated ship-by outranks the undated blocked payout;
    // the info listing sinks to the bottom.
    expect(queue.items.map((item) => item.source)).toEqual([
      "fulfillment-ship-by",
      "settlement-blocked-payout",
      "listing-action",
    ]);
    expect(queue.degraded).toBe(false);
  });

  it("rolls up counts from exactly the rendered items", async () => {
    const queue = await aggregateSellerAttentionQueue(
      [
        staticSource("fulfillment-ship-by", [shipByItem(), shipByItem({ id: "fulfillment-ship-by:ship-2" })]),
        staticSource("listing-action", [
          buildSellerAttentionItem({
            source: "listing-action",
            entityId: "list-1",
            severity: "info",
            summary: { code: "listing-action", params: {} },
            observedAt: "2026-07-01T00:00:00.000Z",
          }),
        ]),
      ],
      CONTEXT,
    );

    expect(queue.rollup.total).toBe(3);
    expect(queue.rollup.bySeverity).toEqual({ critical: 2, warning: 0, info: 1 });
    expect(queue.rollup.bySource["fulfillment-ship-by"]).toBe(2);
    expect(queue.rollup.bySource["listing-action"]).toBe(1);
  });

  it("degrades one failing source without blanking the others", async () => {
    const failing: SellerAttentionSource = {
      id: "settlement-blocked-payout",
      load: async () => {
        throw new Error("settlement read model offline");
      },
    };

    const queue = await aggregateSellerAttentionQueue(
      [staticSource("fulfillment-ship-by", [shipByItem()]), failing],
      CONTEXT,
    );

    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.source).toBe("fulfillment-ship-by");
    expect(queue.degraded).toBe(true);
    const settlementHealth = queue.sources.find((source) => source.id === "settlement-blocked-payout");
    expect(settlementHealth).toEqual({
      id: "settlement-blocked-payout",
      status: "unavailable",
      itemCount: 0,
      reason: "settlement read model offline",
    });
  });

  it("treats a source that emits the wrong shape as unavailable, not as queue corruption", async () => {
    const rogue: SellerAttentionSource = {
      id: "offer-response",
      // Emits an item wearing another source's identity.
      load: async () => [shipByItem() as unknown as SellerAttentionItem],
    };

    const queue = await aggregateSellerAttentionQueue(
      [staticSource("fulfillment-ship-by", [shipByItem()]), rogue],
      CONTEXT,
    );

    expect(queue.items).toHaveLength(1);
    const offerHealth = queue.sources.find((source) => source.id === "offer-response");
    expect(offerHealth?.status).toBe("unavailable");
    expect(offerHealth?.reason).toBe("source returned a non-conforming item");
  });
});
