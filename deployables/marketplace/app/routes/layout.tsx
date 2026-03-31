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

  if (hasPermission(actor, "listings.view")) {
    topNavItems.push({
      key: "listings",
      label: "Listings",
      icon: "package",
      href: "/account/listings",
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
