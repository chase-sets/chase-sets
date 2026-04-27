import { resolveWebHostNavItems } from "@chase-sets/platform-runtime/web";
import { resolveWebHostRouteConfigRecords } from "@chase-sets/platform-runtime/web-route-config";
import type { NavigationItem } from "@chase-sets/design-system";
import { webContextRegistry } from "./generated/web-context-registry";

export function resolveMarketplaceRouteConfigRecords() {
  return resolveWebHostRouteConfigRecords(webContextRegistry, "marketplace-web");
}

export function resolveMarketplaceNavItems(
  slot: "top-nav" | "bottom-nav",
  actor?: Readonly<{ permissions?: readonly string[] }> | null,
): NavigationItem[] {
  const items = resolveWebHostNavItems(webContextRegistry, "marketplace-web", slot, actor);

  if (!actor || slot === "bottom-nav") {
    return slot === "bottom-nav" && actor
      ? orderBuyerNav(items).filter((item) => ["search", "cart", "orders", "account"].includes(item.key))
      : items;
  }

  return groupMarketplaceTopNav(items);
}

const sellerWorkflowKeys = new Set([
  "inventory",
  "listings",
  "market-offers",
  "offers",
  "shipments",
  "fulfillment",
  "sales",
  "reputation",
]);

const buyerTopNavOrder = ["search", "cart", "orders", "account"];

function orderBuyerNav(items: NavigationItem[]): NavigationItem[] {
  return [...items].sort((a, b) => {
    const aIndex = buyerTopNavOrder.indexOf(a.key);
    const bIndex = buyerTopNavOrder.indexOf(b.key);

    if (aIndex === -1 && bIndex === -1) {
      return 0;
    }

    if (aIndex === -1) {
      return 1;
    }

    if (bIndex === -1) {
      return -1;
    }

    return aIndex - bIndex;
  });
}

function groupMarketplaceTopNav(items: NavigationItem[]): NavigationItem[] {
  const sellerItems = items.filter((item) => sellerWorkflowKeys.has(item.key));
  const buyerItems = orderBuyerNav(
    items.filter((item) => !sellerWorkflowKeys.has(item.key)),
  );

  if (sellerItems.length === 0) {
    return buyerItems;
  }

  const sellerGroup: NavigationItem = {
    key: "seller-workspace",
    label: "Sell",
    icon: "package",
    children: sellerItems,
  };

  return [
    ...buyerItems.filter((item) => item.key !== "account"),
    sellerGroup,
    ...buyerItems.filter((item) => item.key === "account"),
  ];
}
