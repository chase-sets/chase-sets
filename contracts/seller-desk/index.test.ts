import { describe, expect, it } from "vitest";
import {
  compareSellerAttentionItems,
  findSellerRouteRedirect,
  SELLER_ATTENTION_SEVERITY_RANK,
  SELLER_ATTENTION_SOURCE_PRIORITY,
  SELLER_ATTENTION_SOURCES,
  SELLER_DESK_ACTIONS,
  SELLER_DESK_DISCLOSURE_RULES,
  SELLER_DESK_SURFACES,
  SELLER_ENTITIES,
  SELLER_ROUTE_MAP,
  sellerSurfaceById,
  type SellerAttentionOrderInput,
  type SellerDeskSurfaceId,
} from "./index";

const surfaceIds = new Set<SellerDeskSurfaceId>(SELLER_DESK_SURFACES.map((surface) => surface.id));
const entityIds = new Set(SELLER_ENTITIES.map((entity) => entity.id));
const pageSurfaces = SELLER_DESK_SURFACES.filter((surface) => surface.routePath !== null);

describe("Seller Desk surfaces", () => {
  it("gives every surface a unique id", () => {
    expect(surfaceIds.size).toBe(SELLER_DESK_SURFACES.length);
  });

  it("gives every page surface a unique absolute route and every drawer a null route", () => {
    const routes = new Set<string>();
    for (const surface of SELLER_DESK_SURFACES) {
      if (surface.kind === "drawer") {
        expect(surface.routePath).toBeNull();
        continue;
      }
      expect(surface.routePath).not.toBeNull();
      const routePath = surface.routePath as string;
      expect(routePath.startsWith("/account/desk")).toBe(true);
      expect(routes.has(routePath)).toBe(false);
      routes.add(routePath);
    }
  });

  it("resolves surfaces by id", () => {
    expect(sellerSurfaceById("seller-home")?.kind).toBe("page");
    expect(sellerSurfaceById("activity-drawer")?.routePath).toBeNull();
  });
});

describe("Seller entities", () => {
  it("gives every entity a home surface that exists", () => {
    for (const entity of SELLER_ENTITIES) {
      expect(surfaceIds.has(entity.homeSurface)).toBe(true);
    }
  });

  it("references every entity from at least one action", () => {
    const referenced = new Set(SELLER_DESK_ACTIONS.map((action) => action.entity));
    for (const entity of SELLER_ENTITIES) {
      expect(referenced.has(entity.id)).toBe(true);
    }
  });
});

describe("Action vocabulary", () => {
  it("has a unique id, a known entity, and a non-empty replaces list per action", () => {
    const ids = new Set<string>();
    for (const action of SELLER_DESK_ACTIONS) {
      expect(ids.has(action.id)).toBe(false);
      ids.add(action.id);
      expect(entityIds.has(action.entity)).toBe(true);
      expect(action.replaces.length).toBeGreaterThan(0);
    }
  });

  it("maps every current form intent to exactly one action, with no intent orphaned", () => {
    const intentOwners = new Map<string, string[]>();
    for (const action of SELLER_DESK_ACTIONS) {
      for (const intent of action.replaces) {
        intentOwners.set(intent, [...(intentOwners.get(intent) ?? []), action.id]);
      }
    }
    // Every intent shipped by a live seller surface today must be covered exactly once.
    const currentSellerIntents = [
      "create-item",
      "adjust-item",
      "restock",
      "create-hold",
      "release-hold",
      "raise-exception",
      "create-batch",
      "commit-batch",
      "resolve-row",
      "create-location",
      "update-location",
      "archive-location",
      "create-listing",
      "publish",
      "preview-listing",
      "update-price",
      "preview-price",
      "pause",
      "bulk-pause-listings",
      "withdraw",
      "bulk-withdraw-listings",
      "enable-listing-availability",
      "set-order-capacity",
      "clear-order-capacity",
      "update-quantity-cap",
      "update-purchase-limits",
      "cancel-away-window",
      "add-listing-evidence",
      "classify-listing-evidence",
      "add-photos",
      "classify-photo",
      "remove-photo",
      "reorder-photos",
      "replace-photo",
      "upload-bulk-reprice",
      "cancel-bulk-reprice",
      "decline-offer",
      "mute-offer-buyer",
      "unmute-offer-buyer",
      "add-selected-offer",
      "remove-sell-list-line",
      "request",
      "start-packing",
      "purchase-label",
      "void-label",
      "dispatch-shipment",
      "deliver-shipment",
      "return-shipment",
      "confirm-payout",
      "preview-payout",
      "edit-payout",
      "manage-payout-account",
      "start-payout-setup",
      "refresh-payout-setup",
      "run-reconciliation",
      "write-off",
      "reverse",
    ];
    for (const intent of currentSellerIntents) {
      const owners = intentOwners.get(intent) ?? [];
      expect(owners, `intent ${intent} must map to exactly one action`).toHaveLength(1);
    }
  });
});

describe("Route map", () => {
  it("gives every route a unique id and current path", () => {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const route of SELLER_ROUTE_MAP) {
      expect(ids.has(route.routeId)).toBe(false);
      ids.add(route.routeId);
      expect(paths.has(route.currentPath)).toBe(false);
      paths.add(route.currentPath);
    }
  });

  it("routes every in-scope seller route to a real Desk surface", () => {
    for (const route of SELLER_ROUTE_MAP) {
      if (route.scope !== "seller") {
        continue;
      }
      expect(route.disposition).not.toBe("out-of-scope");
      expect(route.newHome, `${route.routeId} needs a new home`).not.toBeNull();
      expect(surfaceIds.has(route.newHome as SellerDeskSurfaceId)).toBe(true);
      expect(route.redirectTo, `${route.routeId} needs a redirect`).not.toBeNull();
    }
  });

  it("points every redirect at a real Desk surface route", () => {
    const pagePrefixes = pageSurfaces.map((surface) => (surface.routePath as string).replace(/\/:[^/]+/g, ""));
    for (const route of SELLER_ROUTE_MAP) {
      if (route.redirectTo === null) {
        continue;
      }
      const target = route.redirectTo.replace(/\/:[^/]+/g, "");
      const landed = pagePrefixes.some(
        (prefix) =>
          target === prefix || target.startsWith(`${prefix}/`) || prefix.startsWith(`${target}/`) || target === prefix,
      );
      expect(landed, `${route.routeId} redirect ${route.redirectTo} must land on a Desk surface`).toBe(true);
    }
  });

  it("keeps out-of-scope routes in place with an explicit reason and no redirect", () => {
    for (const route of SELLER_ROUTE_MAP) {
      if (route.disposition !== "out-of-scope") {
        continue;
      }
      expect(route.newHome).toBeNull();
      expect(route.redirectTo).toBeNull();
      expect(route.scope === "seller" ? route.note : "kept").toBeTruthy();
    }
  });

  it("resolves a redirect for an absorbed route and none for a kept-in-place route", () => {
    expect(findSellerRouteRedirect("/account/listings")).toBe("/account/desk");
    expect(findSellerRouteRedirect("/account/security")).toBeNull();
    expect(findSellerRouteRedirect("/does/not/exist")).toBeNull();
  });
});

describe("Attention-queue ordering policy", () => {
  it("ranks severities strictly critical > warning > info", () => {
    expect(SELLER_ATTENTION_SEVERITY_RANK.critical).toBeGreaterThan(SELLER_ATTENTION_SEVERITY_RANK.warning);
    expect(SELLER_ATTENTION_SEVERITY_RANK.warning).toBeGreaterThan(SELLER_ATTENTION_SEVERITY_RANK.info);
  });

  it("gives every source a distinct tiebreak priority with ship-by and money highest", () => {
    const priorities = Object.values(SELLER_ATTENTION_SOURCE_PRIORITY);
    expect(new Set(priorities).size).toBe(priorities.length);
    expect(SELLER_ATTENTION_SOURCE_PRIORITY["fulfillment-ship-by"]).toBeGreaterThan(
      SELLER_ATTENTION_SOURCE_PRIORITY["listing-action"],
    );
    expect(SELLER_ATTENTION_SOURCE_PRIORITY["settlement-blocked-payout"]).toBeGreaterThan(
      SELLER_ATTENTION_SOURCE_PRIORITY["offer-response"],
    );
  });

  it("points every source at a real deep-link surface and a known entity", () => {
    for (const source of SELLER_ATTENTION_SOURCES) {
      expect(surfaceIds.has(source.target)).toBe(true);
      expect(entityIds.has(source.entity)).toBe(true);
      if (source.availability === "gated") {
        expect(source.gatedOn).toBeTruthy();
      }
    }
  });

  it("orders a mixed queue: severity, then deadline, then source priority, then age", () => {
    const staleListing: SellerAttentionOrderInput = {
      severity: "info",
      source: "listing-action",
      observedAt: "2026-07-01T00:00:00Z",
    };
    const shipByCritical: SellerAttentionOrderInput = {
      severity: "critical",
      source: "fulfillment-ship-by",
      dueAt: "2026-07-15T00:00:00Z",
      observedAt: "2026-07-10T00:00:00Z",
    };
    const blockedPayoutCritical: SellerAttentionOrderInput = {
      severity: "critical",
      source: "settlement-blocked-payout",
      dueAt: "2026-07-15T00:00:00Z",
      observedAt: "2026-07-05T00:00:00Z",
    };
    const offerWarning: SellerAttentionOrderInput = {
      severity: "warning",
      source: "offer-response",
      observedAt: "2026-07-02T00:00:00Z",
    };

    const ordered = [staleListing, offerWarning, blockedPayoutCritical, shipByCritical].sort(
      compareSellerAttentionItems,
    );
    expect(ordered.map((item) => item.source)).toEqual([
      "fulfillment-ship-by", // critical, same deadline, higher source priority than payout
      "settlement-blocked-payout", // critical
      "offer-response", // warning
      "listing-action", // info
    ]);
  });

  it("orders soonest deadline first within the same severity", () => {
    const soon: SellerAttentionOrderInput = {
      severity: "critical",
      source: "settlement-blocked-payout",
      dueAt: "2026-07-15T00:00:00Z",
      observedAt: "2026-07-10T00:00:00Z",
    };
    const later: SellerAttentionOrderInput = {
      severity: "critical",
      source: "fulfillment-ship-by",
      dueAt: "2026-07-20T00:00:00Z",
      observedAt: "2026-07-01T00:00:00Z",
    };
    expect([later, soon].sort(compareSellerAttentionItems).map((item) => item.source)).toEqual([
      "settlement-blocked-payout",
      "fulfillment-ship-by",
    ]);
  });

  it("is a total order — comparing an item with itself returns 0", () => {
    const item: SellerAttentionOrderInput = {
      severity: "warning",
      source: "inventory-resolution",
      observedAt: "2026-07-03T00:00:00Z",
    };
    expect(compareSellerAttentionItems(item, item)).toBe(0);
  });
});

describe("Disclosure rules", () => {
  it("states the inline-first, drawer-for-depth, page-for-forward-nav law", () => {
    expect(SELLER_DESK_DISCLOSURE_RULES.length).toBeGreaterThanOrEqual(4);
    expect(SELLER_DESK_DISCLOSURE_RULES[0].toLowerCase()).toContain("inline");
  });
});
