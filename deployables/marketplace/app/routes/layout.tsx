import { Outlet, useLocation, useRouteLoaderData } from "react-router";
import type { NavigationItem } from "@chase-sets/design-system";
import { DiscoveryShellLayout } from "@chase-sets/discovery/web";

type MarketplaceActor = {
  permissions?: readonly string[];
} | null;

const browseNavItem = {
  key: "search",
  label: "Browse",
  icon: "search",
  href: "/search",
} satisfies NavigationItem;

function hasPermission(actor: MarketplaceActor, permission: string) {
  return actor?.permissions?.includes(permission) ?? false;
}

function getActiveKey(pathname: string) {
  if (pathname.startsWith("/account/market-offers")) {
    return "market-offers";
  }

  if (pathname.startsWith("/account/offers")) {
    return "offers";
  }

  if (pathname.startsWith("/account/shipments")) {
    return "shipments";
  }

  if (pathname.startsWith("/account/fulfillment")) {
    return "fulfillment";
  }

  if (pathname.startsWith("/account/orders")) {
    return "orders";
  }

  if (pathname.startsWith("/account/sales")) {
    return "sales";
  }

  if (pathname.startsWith("/account/cart")) {
    return "cart";
  }

  if (pathname.startsWith("/account/listings")) {
    return "listings";
  }

  if (pathname.startsWith("/account/inventory")) {
    return "inventory";
  }

  if (pathname.startsWith("/account")) {
    return "account";
  }

  if (pathname.startsWith("/sign-in")) {
    return "sign-in";
  }

  if (pathname.startsWith("/register")) {
    return "register";
  }

  return "search";
}

function getShellNavItems(actor: MarketplaceActor) {
  const topNavItems: NavigationItem[] = [browseNavItem];

  if (!actor) {
    const signedOutNavItems: NavigationItem[] = [
      ...topNavItems,
      { key: "sign-in", label: "Sign In", icon: "user", href: "/sign-in" },
      { key: "register", label: "Register", icon: "plus", href: "/register" },
    ];

    return {
      topNavItems: signedOutNavItems,
      bottomNavItems: signedOutNavItems,
    };
  }

  if (hasPermission(actor, "inventory.view")) {
    topNavItems.push({
      key: "inventory",
      label: "Inventory",
      icon: "package",
      href: "/account/inventory",
    });
  }

  if (hasPermission(actor, "orders.manage")) {
    topNavItems.push({
      key: "cart",
      label: "Cart",
      icon: "cart",
      href: "/account/cart",
    });
  }

  if (hasPermission(actor, "listings.view")) {
    topNavItems.push({
      key: "listings",
      label: "Listings",
      icon: "package",
      href: "/account/listings",
    });
  }

  if (hasPermission(actor, "offers.view") && hasPermission(actor, "listings.view")) {
    topNavItems.push({
      key: "market-offers",
      label: "Market Offers",
      icon: "package",
      href: "/account/market-offers",
    });
  }

  if (hasPermission(actor, "offers.view")) {
    topNavItems.push({
      key: "offers",
      label: "Offers",
      icon: "package",
      href: "/account/offers",
    });
  }

  if (hasPermission(actor, "fulfillment.view")) {
    topNavItems.push({
      key: "shipments",
      label: "Shipments",
      icon: "package",
      href: "/account/shipments",
    });
  }

  if (hasPermission(actor, "orders.view")) {
    topNavItems.push({
      key: "orders",
      label: "Orders",
      icon: "cart",
      href: "/account/orders",
    });
  }

  if (hasPermission(actor, "fulfillment.view") && hasPermission(actor, "fulfillment.manage")) {
    topNavItems.push({
      key: "fulfillment",
      label: "Fulfillment",
      icon: "package",
      href: "/account/fulfillment",
    });
  }

  if (hasPermission(actor, "orders.view") && hasPermission(actor, "listings.view")) {
    topNavItems.push({
      key: "sales",
      label: "Sales",
      icon: "package",
      href: "/account/sales",
    });
  }

  if (hasPermission(actor, "accounts.view")) {
    topNavItems.push({
      key: "account",
      label: "Account",
      icon: "user",
      href: "/account",
    });
  }

  return {
    topNavItems,
    bottomNavItems: topNavItems,
  };
}

export default function MarketplaceLayoutRoute() {
  const location = useLocation();
  const rootData = useRouteLoaderData("root") as
    | {
        actor?: MarketplaceActor;
      }
    | undefined;
  const { topNavItems, bottomNavItems } = getShellNavItems(rootData?.actor ?? null);

  return (
    <DiscoveryShellLayout
      activeKey={getActiveKey(location.pathname)}
      topNavItems={topNavItems}
      bottomNavItems={bottomNavItems}
    >
      <Outlet />
    </DiscoveryShellLayout>
  );
}
