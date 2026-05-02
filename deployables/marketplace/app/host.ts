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

const sellingWorkflowKeys = new Set([
  "inventory",
  "listings",
  "offer-matches",
  "sales",
  "sale-shipments",
  "reviews",
  "payouts",
]);

const sellingInfrastructureKeys = new Set([
  "shipments",
]);

const accountTopNavOrder = ["search", "cart", "purchases", "account"];
const sellingNavOrder = [
  "inventory",
  "listings",
  "offer-matches",
  "sales",
  "sale-shipments",
  "reviews",
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

  return override ? { ...item, ...override } : item;
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
    visibleItems.filter((item) => ["search", "cart", "purchases"].includes(item.key)),
  );

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
    ...accountItems,
    sellingGroup,
  ].slice(0, 4);
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
    visibleItems.filter((item) => !sellingWorkflowKeys.has(item.key) && item.key !== "submitted-offers"),
  );
  const submittedOffers = visibleItems.find((item) => item.key === "submitted-offers");
  const accountItem = accountItems.find((item) => item.key === "account");
  const accountGroup: NavigationItem | undefined = accountItem && submittedOffers
    ? {
        ...accountItem,
        href: undefined,
        children: [
          accountItem,
          submittedOffers,
        ],
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
