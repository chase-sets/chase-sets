import { Outlet, useLocation, useRouteLoaderData } from "react-router";
import { Button } from "@chase-sets/design-system";
import { DiscoveryShellLayout } from "@chase-sets/discovery/web";
import { resolveMarketplaceNavItems } from "../host";

type MarketplaceActor = {
  permissions?: readonly string[];
} | null;

function getActiveKey(pathname: string) {
  if (pathname.startsWith("/account/buyer-offer-matches")) {
    return "buyer-offer-matches";
  }

  if (pathname.startsWith("/account/submitted-buyer-offers")) {
    return "submitted-buyer-offers";
  }

  if (pathname.startsWith("/account/shipments")) {
    return "shipments";
  }

  if (pathname.startsWith("/account/reviews")) {
    return "reviews";
  }

  if (pathname.startsWith("/account/payouts") || pathname.startsWith("/account/settlement")) {
    return "payouts";
  }

  if (pathname.startsWith("/account/purchases")) {
    return "purchases";
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
  const topNavItems = resolveMarketplaceNavItems("top-nav", actor);
  const bottomNavItems = resolveMarketplaceNavItems("bottom-nav", actor);

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
