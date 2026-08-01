import { t } from "@chase-sets/localization";
import { resolveWebHostNavItems } from "@chase-sets/platform-runtime/web";
import { resolveWebHostRouteConfigRecords } from "@chase-sets/platform-runtime/web-route-config";
import type { AccountMenuItem, NavigationItem } from "@chase-sets/design-system";
import { webContextRegistry } from "./context-registry";

export function resolveMarketplaceRouteConfigRecords() {
  return resolveWebHostRouteConfigRecords(webContextRegistry, "marketplace-web");
}

export function resolveMarketplaceNavItems(
  slot: "top-nav" | "bottom-nav",
  actor?: Readonly<{ permissions?: readonly string[]; roleKey?: string | null }> | null,
  options: Readonly<{ cartCount?: number }> = {},
): NavigationItem[] {
  if (isGuestCheckoutActor(actor)) {
    const publicItems = resolveWebHostNavItems(webContextRegistry, "marketplace-web", slot, null)
      .map((item) => toTraderNavItem(item, slot))
      .filter((item) => item.key === "search");

    return moveCartLast(
      withCartNavigation(publicItems, options.cartCount ?? 0, { includeGuestCart: true, includeEmptyGuestCart: true }),
    );
  }

  const items = resolveWebHostNavItems(webContextRegistry, "marketplace-web", slot, actor).map((item) =>
    toTraderNavItem(item, slot),
  );
  const cartCount = options.cartCount ?? 0;

  if (!actor || slot === "bottom-nav") {
    const resolvedItems = slot === "bottom-nav" && actor ? buildMarketplaceBottomNav(items) : items;
    const withCart = withCartNavigation(resolvedItems, cartCount, { includeGuestCart: !actor });

    return slot === "top-nav" ? moveCartLast(withCart) : withCart;
  }

  return moveCartLast(withCartNavigation(groupMarketplaceTopNav(items), cartCount));
}

export function resolveMarketplaceAccountMenuItems(
  actor?: Readonly<{ permissions?: readonly string[]; roleKey?: string | null }> | null,
): AccountMenuItem[] {
  if (!actor || isGuestCheckoutActor(actor)) {
    return [];
  }

  return orderAccountChildNav(
    resolveWebHostNavItems(webContextRegistry, "marketplace-web", "top-nav", actor)
      .map((item) => toTraderNavItem(item, "top-nav"))
      .filter((item) => accountChildKeys.has(item.key) && Boolean(item.href)),
  ).flatMap((item) =>
    item.href
      ? [
          {
            key: item.key,
            label: item.label,
            href: item.href,
            icon: item.icon,
          },
        ]
      : [],
  );
}

const sellingWorkflowKeys = new Set([
  "inventory",
  "inventory-imports",
  "inventory-restock-decisions",
  "listings",
  "offer-matches",
  "sales",
  "sale-shipments",
]);

const sellingInfrastructureKeys = new Set(["shipments"]);
const topNavUtilityKeys = new Set(["account", "cart", "notifications", "register", "sign-in"]);

function isGuestCheckoutActor(actor?: Readonly<{ roleKey?: string | null }> | null) {
  return actor?.roleKey === "guest-buyer";
}

const accountChildKeys = new Set(["account", "wallet", "payouts", "submitted-offers", "reviews"]);
const accountTopNavOrder = ["search", "cart", "purchases", "notifications", "account", "reviews"];
const accountChildNavOrder = ["account", "wallet", "payouts", "submitted-offers", "reviews"];
const sellingNavOrder = [
  "inventory",
  "inventory-imports",
  "inventory-restock-decisions",
  "listings",
  "offer-matches",
  "sales",
  "sale-shipments",
];

const traderNavOverrides: Record<string, Partial<NavigationItem>> = {
  account: {
    icon: "user",
  },
  inventory: {
    label: t("marketplace.app.host.inventory"),
    icon: "package",
  },
  "inventory-imports": {
    label: t("marketplace.app.host.import"),
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
  notifications: {
    label: t("marketplace.app.host.notifications"),
    icon: "bell",
    href: undefined,
  },
  sales: {
    label: t("marketplace.app.host.sales"),
    icon: "dollar",
  },
  "sale-shipments": {
    label: t("marketplace.app.host.shipping"),
    icon: "truck",
  },
  wallet: {
    label: t("marketplace.app.host.wallet"),
    icon: "wallet",
  },
  payouts: {
    label: t("marketplace.app.host.payouts"),
    icon: "wallet",
  },
};

function toTraderNavItem(item: NavigationItem, slot: "top-nav" | "bottom-nav"): NavigationItem {
  const override = traderNavOverrides[item.key];
  const placement = topNavUtilityKeys.has(item.key) ? "utility" : item.placement;
  const resolvedOverride =
    item.key === "notifications" && slot === "bottom-nav" ? { ...override, label: item.label } : override;

  return resolvedOverride ? { ...item, placement, ...resolvedOverride } : { ...item, placement };
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
  options: Readonly<{ includeGuestCart?: boolean; includeEmptyGuestCart?: boolean }> = {},
): NavigationItem[] {
  const badge = formatCartBadge(cartCount);

  if (items.some((item) => item.key === "cart")) {
    return items.map((item) => applyCartBadge(item, badge));
  }

  if (!options.includeGuestCart || (!badge && !options.includeEmptyGuestCart)) {
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

  return [...items, cartItem];
}

function moveCartLast(items: NavigationItem[]): NavigationItem[] {
  const cartItem = items.find((item) => item.key === "cart");

  return cartItem ? [...items.filter((item) => item.key !== "cart"), cartItem] : items;
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

function sellingLandingHref(items: readonly NavigationItem[]): string {
  return items.find((item) => item.key === "listings")?.href ?? items[0]?.href ?? "/account/listings";
}

function buildMarketplaceBottomNav(items: NavigationItem[]): NavigationItem[] {
  const visibleItems = items.filter((item) => !sellingInfrastructureKeys.has(item.key));
  const sellingItems = orderSellingNav(visibleItems.filter((item) => sellingWorkflowKeys.has(item.key)));
  const accountItems = orderAccountNav(
    visibleItems.filter((item) =>
      ["search", "cart", "purchases", "notifications", "account", "reviews"].includes(item.key),
    ),
  );
  const moneyItem = visibleItems.find((item) => item.key === "money");
  const accountItem = accountItems.find((item) => item.key === "account");
  const accountGroup: NavigationItem | undefined = accountItem
    ? {
        ...accountItem,
        children: orderAccountChildNav(visibleItems.filter((item) => accountChildKeys.has(item.key))),
      }
    : undefined;

  if (sellingItems.length === 0) {
    const primaryAccountItems = compactBottomPrimaryItems(
      accountItems.filter((item) => !["account", "reviews"].includes(item.key)),
      5 - (moneyItem ? 1 : 0) - (accountGroup ? 1 : 0),
    );

    return [...primaryAccountItems, ...(moneyItem ? [moneyItem] : []), ...(accountGroup ? [accountGroup] : [])].slice(
      0,
      5,
    );
  }

  const sellingGroup: NavigationItem = {
    key: "selling-workspace",
    label: t("marketplace.app.host.sell"),
    icon: "store",
    href: sellingLandingHref(sellingItems),
    children: sellingItems,
  };

  const primaryAccountItems = compactBottomPrimaryItems(
    accountItems.filter((item) => !["account", "reviews"].includes(item.key)),
    3,
  );

  return [
    ...primaryAccountItems,
    sellingGroup,
    ...(moneyItem ? [moneyItem] : []),
    ...(accountGroup ? [accountGroup] : []),
  ].slice(0, 5);
}

function compactBottomPrimaryItems(items: NavigationItem[], capacity: number): NavigationItem[] {
  if (items.length <= capacity || !items.some((item) => item.key === "notifications")) {
    return items;
  }

  return items.filter((item) => item.key !== "purchases");
}

function groupMarketplaceTopNav(items: NavigationItem[]): NavigationItem[] {
  const visibleItems = items.filter((item) => !sellingInfrastructureKeys.has(item.key));
  const sellingItems = orderSellingNav(visibleItems.filter((item) => sellingWorkflowKeys.has(item.key)));
  const accountItems = orderAccountNav(
    visibleItems.filter((item) => !sellingWorkflowKeys.has(item.key) && !accountChildKeys.has(item.key)),
  );

  if (sellingItems.length === 0) {
    return accountItems;
  }

  const sellingGroup: NavigationItem = {
    key: "selling-workspace",
    label: t("marketplace.app.host.sell.2"),
    icon: "store",
    href: sellingLandingHref(sellingItems),
    children: sellingItems,
  };

  return [...accountItems, sellingGroup];
}
