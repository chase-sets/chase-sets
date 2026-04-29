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
  const items = resolveWebHostNavItems(webContextRegistry, "marketplace-web", slot, actor)
    .map(toTraderNavItem);

  if (!actor || slot === "bottom-nav") {
    return slot === "bottom-nav" && actor
      ? buildMarketplaceBottomNav(items, actor)
      : items;
  }

  return groupMarketplaceTopNav(items, actor);
}

const sellerWorkflowKeys = new Set([
  "inventory",
  "listings",
  "buyer-offer-matches",
  "sales",
  "reviews",
  "payouts",
]);

const sellerInfrastructureKeys = new Set([
  "shipments",
]);

const buyerTopNavOrder = ["search", "cart", "purchases", "account"];
const sellerNavOrder = ["inventory", "listings", "buyer-offer-matches", "sales", "reviews", "payouts"];

const traderNavOverrides: Record<string, Partial<NavigationItem>> = {
  account: {
    icon: "user",
  },
  inventory: {
    label: "Inventory",
    icon: "package",
  },
  listings: {
    label: "Listings",
    icon: "store",
  },
  "buyer-offer-matches": {
    label: "Buyer Offer Matches",
    icon: "tag",
  },
  "submitted-buyer-offers": {
    label: "Submitted Buyer Offers",
    icon: "message",
  },
  orders: {
    label: "Purchases",
    icon: "bag",
  },
  reviews: {
    label: "Reviews",
    icon: "star",
  },
  sales: {
    label: "Sales",
    icon: "dollar",
  },
};

function hasPermission(
  actor: Readonly<{ permissions?: readonly string[] }> | null | undefined,
  permission: string,
) {
  return actor?.permissions?.includes(permission) ?? false;
}

function toTraderNavItem(item: NavigationItem): NavigationItem {
  const override = traderNavOverrides[item.key];

  return override ? { ...item, ...override } : item;
}

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

function orderSellerNav(items: NavigationItem[]): NavigationItem[] {
  return [...items].sort((a, b) => {
    const aIndex = sellerNavOrder.indexOf(a.key);
    const bIndex = sellerNavOrder.indexOf(b.key);

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

function withSyntheticSellerItems(
  items: NavigationItem[],
  actor: Readonly<{ permissions?: readonly string[] }> | null | undefined,
): NavigationItem[] {
  if (!hasPermission(actor, "payouts.view")) {
    return items;
  }

  return [
    ...items,
    {
      key: "payouts",
      label: "Payouts",
      icon: "wallet",
      href: "/account/payouts",
    },
  ];
}

function sellerLandingHref(items: readonly NavigationItem[]): string {
  return items.find((item) => item.key === "listings")?.href
    ?? items[0]?.href
    ?? "/account/listings";
}

function buildMarketplaceBottomNav(
  items: NavigationItem[],
  actor: Readonly<{ permissions?: readonly string[] }> | null | undefined,
): NavigationItem[] {
  const visibleItems = items.filter((item) => !sellerInfrastructureKeys.has(item.key));
  const sellerItems = orderSellerNav(
    withSyntheticSellerItems(
      visibleItems.filter((item) => sellerWorkflowKeys.has(item.key)),
      actor,
    ),
  );
  const buyerItems = orderBuyerNav(
    visibleItems.filter((item) => ["search", "cart", "purchases"].includes(item.key)),
  );

  if (sellerItems.length === 0) {
    return orderBuyerNav(
      visibleItems.filter((item) => ["search", "cart", "purchases", "account"].includes(item.key)),
    );
  }

  const sellerGroup: NavigationItem = {
    key: "seller-workspace",
    label: "Sell",
    icon: "store",
    href: sellerLandingHref(sellerItems),
    children: sellerItems,
  };

  return [
    ...buyerItems,
    sellerGroup,
  ].slice(0, 4);
}

function groupMarketplaceTopNav(
  items: NavigationItem[],
  actor: Readonly<{ permissions?: readonly string[] }> | null | undefined,
): NavigationItem[] {
  const visibleItems = items.filter((item) => !sellerInfrastructureKeys.has(item.key));
  const sellerItems = orderSellerNav(
    withSyntheticSellerItems(
      visibleItems.filter((item) => sellerWorkflowKeys.has(item.key)),
      actor,
    ),
  );
  const buyerItems = orderBuyerNav(
    visibleItems.filter((item) => !sellerWorkflowKeys.has(item.key) && item.key !== "submitted-buyer-offers"),
  );
  const submittedBuyerOffers = visibleItems.find((item) => item.key === "submitted-buyer-offers");
  const accountItem = buyerItems.find((item) => item.key === "account");
  const accountGroup: NavigationItem | undefined = accountItem && submittedBuyerOffers
    ? {
        ...accountItem,
        href: undefined,
        children: [
          accountItem,
          submittedBuyerOffers,
        ],
      }
    : accountItem;

  if (sellerItems.length === 0) {
    return [
      ...buyerItems.filter((item) => item.key !== "account"),
      ...(accountGroup ? [accountGroup] : []),
    ];
  }

  const sellerGroup: NavigationItem = {
    key: "seller-workspace",
    label: "Sell",
    icon: "store",
    href: sellerLandingHref(sellerItems),
    children: sellerItems,
  };

  return [
    ...buyerItems.filter((item) => item.key !== "account"),
    sellerGroup,
    ...(accountGroup ? [accountGroup] : []),
  ];
}
