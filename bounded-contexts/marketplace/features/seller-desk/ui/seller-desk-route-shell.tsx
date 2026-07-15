import { t } from "@chase-sets/localization";
import { NavigationHeader, type NavigationHeaderItem } from "@chase-sets/design-system";
import { resolveSellerRouteRedirect } from "@chase-sets/seller-desk";
import type { ReactNode } from "react";

export type SellerDeskShellActor = Readonly<{ permissions?: readonly string[] }> | null;

export type SellerDeskNavigationItem = NavigationHeaderItem &
  Readonly<{
    key:
      | "seller-desk-home"
      | "seller-desk-fulfillment"
      | "seller-desk-money"
      | "seller-desk-offers"
      | "seller-desk-settings";
  }>;

function hasAnyPermission(actor: SellerDeskShellActor, permissions: readonly string[]) {
  const available = new Set(actor?.permissions ?? []);
  return permissions.some((permission) => available.has(permission));
}

export function resolveSellerDeskNavigation(actor: SellerDeskShellActor): SellerDeskNavigationItem[] {
  const items: SellerDeskNavigationItem[] = [
    {
      key: "seller-desk-home",
      label: t("marketplace.features.sellerDesk.ui.routeShell.home"),
      href: "/account/desk",
    },
  ];

  if (hasAnyPermission(actor, ["fulfillment.view"])) {
    items.push({
      key: "seller-desk-fulfillment",
      label: t("marketplace.features.sellerDesk.ui.routeShell.fulfillment"),
      href: "/account/desk/shipments",
    });
  }
  if (hasAnyPermission(actor, ["payouts.view"])) {
    items.push({
      key: "seller-desk-money",
      label: t("marketplace.features.sellerDesk.ui.routeShell.money"),
      href: "/account/desk/money",
    });
  }
  if (hasAnyPermission(actor, ["offers.view"])) {
    items.push({
      key: "seller-desk-offers",
      label: t("marketplace.features.sellerDesk.ui.routeShell.offers"),
      href: "/account/desk/offers",
    });
  }
  if (hasAnyPermission(actor, ["inventory.view", "payouts.view"])) {
    items.push({
      key: "seller-desk-settings",
      label: t("marketplace.features.sellerDesk.ui.routeShell.settings"),
      href: "/account/desk/settings",
    });
  }

  return items;
}

function activeNavigationKey(pathname: string): SellerDeskNavigationItem["key"] {
  if (pathname.startsWith("/account/desk/shipments")) {
    return "seller-desk-fulfillment";
  }
  if (pathname.startsWith("/account/desk/money") || pathname.startsWith("/account/desk/payouts")) {
    return "seller-desk-money";
  }
  if (pathname.startsWith("/account/desk/offers")) {
    return "seller-desk-offers";
  }
  if (pathname.startsWith("/account/desk/settings")) {
    return "seller-desk-settings";
  }
  return "seller-desk-home";
}

export function resolveSellerDeskLegacyRoute(pathname: string, search = "") {
  return resolveSellerRouteRedirect(pathname, search);
}

export function SellerDeskRouteShell({
  pathname,
  actor,
  children,
}: {
  pathname: string;
  actor: SellerDeskShellActor;
  children: ReactNode;
}) {
  const activeKey = activeNavigationKey(pathname);
  const items = resolveSellerDeskNavigation(actor).map((item) => ({
    label: item.label,
    href: item.href,
    active: item.key === activeKey,
  }));

  return (
    <>
      <NavigationHeader
        brand={t("marketplace.features.sellerDesk.ui.routeShell.title")}
        description={t("marketplace.features.sellerDesk.ui.routeShell.description")}
        items={items}
        ariaLabel={t("marketplace.features.sellerDesk.ui.routeShell.navigation")}
        sticky={false}
      />
      {children}
    </>
  );
}
