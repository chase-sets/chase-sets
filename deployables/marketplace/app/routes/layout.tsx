import { Outlet, useLocation, useRouteLoaderData } from "react-router";
import { Button } from "@chase-sets/design-system";
import { DiscoveryShellLayout } from "@chase-sets/discovery/web";
import {
  createMarketplaceBottomNavItems,
  createMarketplaceTopNavItems,
} from "../context-shell.generated";

type MarketplaceActor = {
  permissions?: readonly string[];
} | null;

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

  if (pathname.startsWith("/account/reputation") || pathname.startsWith("/account/reviews")) {
    return "reputation";
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

export default function MarketplaceLayoutRoute() {
  const location = useLocation();
  const rootData = useRouteLoaderData("root") as
    | {
        actor?: MarketplaceActor;
      }
    | undefined;
  const actor = rootData?.actor ?? null;
  const topNavItems = createMarketplaceTopNavItems(actor);
  const bottomNavItems = createMarketplaceBottomNavItems(actor);

  return (
    <DiscoveryShellLayout
      activeKey={getActiveKey(location.pathname)}
      topNavItems={topNavItems}
      bottomNavItems={bottomNavItems}
      actions={
        rootData?.actor ? (
          <form action="/sign-out" method="post">
            <Button type="submit" tone="secondary">
              Sign Out
            </Button>
          </form>
        ) : null
      }
    >
      <Outlet />
    </DiscoveryShellLayout>
  );
}
