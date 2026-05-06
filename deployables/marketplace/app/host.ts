import { t } from "@chase-sets/localization";
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
  options: Readonly<{ cartCount?: number }> = {},
): NavigationItem[] {
  const items = resolveWebHostNavItems(webContextRegistry, "marketplace-web", slot, actor)
    .map(toTraderNavItem);
  const cartCount = options.cartCount ?? 0;

  if (!actor || slot === "bottom-nav") {
    const resolvedItems = slot === "bottom-nav" && actor
      ? buildMarketplaceBottomNav(items, actor)
      : items;
    const withCart = withCartNavigation(resolvedItems, cartCount, { includeGuestCart: !actor });

    return slot === "top-nav" ? moveCartLast(withCart) : withCart;
  }

  return moveCartLast(withCartNavigation(groupMarketplaceTopNav(items, actor), cartCount));
}

const sellingWorkflowKeys = new Set([
  "inventory",
  "listings",
  "offer-matches",
  "sales",
  "sale-shipments",
  "payouts",
]);

const sellingInfrastructureKeys = new Set([
  "shipments",
]);
const topNavUtilityKeys = new Set(["account", "cart", "register", "sign-in"]);

const accountTopNavOrder = ["search", "cart", "purchases", "account", "reviews"];
const accountChildNavOrder = ["account", "submitted-offers", "reviews"];
const sellingNavOrder = [
  "inventory",
  "listings",
  "offer-matches",
  "sales",
  "sale-shipments",
  "payouts",
];

const traderNavOverrides: Record<string, Partial<NavigationItem>> = {
  account: {
    icon: "user",
  },
  inventory: {
    label: t("marketplace.app.host.inventory"),
    icon: "package",
  },
  listings: {
    label: t("marketplace.app.host.listings"),
    icon: "store",
  },
  "offer-matches": {
    label: t("marketplace.app.host.offer.matches"),
    icon: "tag",
  },
  "submitted-offers": {
    label: t("marketplace.app.host.submitted.offers"),
    icon: "message",
  },
  orders: {
    label: t("marketplace.app.host.purchases"),
    icon: "bag",
  },
  reviews: {
    label: t("marketplace.app.host.reviews"),
    icon: "star",
  },
  sales: {
    label: t("marketplace.app.host.sales"),
    icon: "dollar",
  },
  "sale-shipments": {
    label: t("marketplace.app.host.shipping"),
    icon: "truck",
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
  const placement = topNavUtilityKeys.has(item.key) ? "utility" : item.placement;

  return override ? { ...item, placement, ...override } : { ...item, placement };
}

function formatCartBadge(count: number) {
  if (count <= 0) {
    return undefined;
  }

  return count > 99 ? "99+" : String(count);
}

function applyCartBadge(item: NavigationItem, badge: string | undefined): NavigationItem {
  return item.key === "cart"
    ? { ...item, badge, placement: "utility" }
    : {
        ...item,
        children: item.children?.map((child) => applyCartBadge(child, badge)),
      };
}

function withCartNavigation(
  items: NavigationItem[],
  cartCount: number,
  options: Readonly<{ includeGuestCart?: boolean }> = {},
): NavigationItem[] {
  const badge = formatCartBadge(cartCount);

  if (items.some((item) => item.key === "cart")) {
    return items.map((item) => applyCartBadge(item, badge));
  }

  if (!options.includeGuestCart || !badge) {
    return items;
  }

  const cartItem: NavigationItem = {
    key: "cart",
    label: t("marketplace.app.host.cart"),
    icon: "cart",
    href: "/account/cart",
    badge,
    placement: "utility",
  };

  return [
    ...items,
    cartItem,
  ];
}

function moveCartLast(items: NavigationItem[]): NavigationItem[] {
  const cartItem = items.find((item) => item.key === "cart");

  return cartItem
    ? [
        ...items.filter((item) => item.key !== "cart"),
        cartItem,
      ]
    : items;
}

function orderAccountNav(items: NavigationItem[]): NavigationItem[] {
  return [...items].sort((a, b) => {
    const aIndex = accountTopNavOrder.indexOf(a.key);
    const bIndex = accountTopNavOrder.indexOf(b.key);

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

function orderAccountChildNav(items: NavigationItem[]): NavigationItem[] {
  return [...items].sort((a, b) => {
    const aIndex = accountChildNavOrder.indexOf(a.key);
    const bIndex = accountChildNavOrder.indexOf(b.key);

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

function orderSellingNav(items: NavigationItem[]): NavigationItem[] {
  return [...items].sort((a, b) => {
    const aIndex = sellingNavOrder.indexOf(a.key);
    const bIndex = sellingNavOrder.indexOf(b.key);

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

function withSyntheticPayoutItems(
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
      label: t("marketplace.app.host.payouts"),
      icon: "wallet",
      href: "/account/payouts",
    },
  ];
}

function sellingLandingHref(items: readonly NavigationItem[]): string {
  return items.find((item) => item.key === "listings")?.href
    ?? items[0]?.href
    ?? "/account/listings";
}

function buildMarketplaceBottomNav(
  items: NavigationItem[],
  actor: Readonly<{ permissions?: readonly string[] }> | null | undefined,
): NavigationItem[] {
  const visibleItems = items.filter((item) => !sellingInfrastructureKeys.has(item.key));
  const sellingItems = orderSellingNav(
    withSyntheticPayoutItems(
      visibleItems.filter((item) => sellingWorkflowKeys.has(item.key)),
      actor,
    ),
  );
  const accountItems = orderAccountNav(
    visibleItems.filter((item) => ["search", "cart", "purchases", "account", "reviews"].includes(item.key)),
  );
  const accountItem = accountItems.find((item) => item.key === "account");
  const accountGroup: NavigationItem | undefined = accountItem
    ? {
        ...accountItem,
        children: orderAccountChildNav(
          visibleItems.filter((item) => ["account", "submitted-offers", "reviews"].includes(item.key)),
        ),
      }
    : undefined;

  if (sellingItems.length === 0) {
    return orderAccountNav(
      visibleItems.filter((item) => ["search", "cart", "purchases", "account"].includes(item.key)),
    );
  }

  const sellingGroup: NavigationItem = {
    key: "selling-workspace",
    label: t("marketplace.app.host.sell"),
    icon: "store",
    href: sellingLandingHref(sellingItems),
    children: sellingItems,
  };

  return [
    ...accountItems.filter((item) => !["account", "reviews"].includes(item.key)),
    sellingGroup,
    ...(accountGroup ? [accountGroup] : []),
  ].slice(0, 5);
}

function groupMarketplaceTopNav(
  items: NavigationItem[],
  actor: Readonly<{ permissions?: readonly string[] }> | null | undefined,
): NavigationItem[] {
  const visibleItems = items.filter((item) => !sellingInfrastructureKeys.has(item.key));
  const sellingItems = orderSellingNav(
    withSyntheticPayoutItems(
      visibleItems.filter((item) => sellingWorkflowKeys.has(item.key)),
      actor,
    ),
  );
  const accountItems = orderAccountNav(
    visibleItems.filter((item) => !sellingWorkflowKeys.has(item.key) && !["submitted-offers", "reviews"].includes(item.key)),
  );
  const accountItem = accountItems.find((item) => item.key === "account");
  const accountChildren = orderAccountChildNav(
    visibleItems.filter((item) => ["account", "submitted-offers", "reviews"].includes(item.key)),
  );
  const accountGroup: NavigationItem | undefined = accountItem && accountChildren.length > 1
    ? {
        ...accountItem,
        href: undefined,
        children: accountChildren,
      }
    : accountItem;

  if (sellingItems.length === 0) {
    return [
      ...accountItems.filter((item) => item.key !== "account"),
      ...(accountGroup ? [accountGroup] : []),
    ];
  }

  const sellingGroup: NavigationItem = {
    key: "selling-workspace",
    label: t("marketplace.app.host.sell.2"),
    icon: "store",
    href: sellingLandingHref(sellingItems),
    children: sellingItems,
  };

  return [
    ...accountItems.filter((item) => item.key !== "account"),
    sellingGroup,
    ...(accountGroup ? [accountGroup] : []),
  ];
}
