import { t } from "@chase-sets/localization";
import { Outlet, useLocation, useRouteLoaderData } from "react-router";
import { Banner, Button, LinkButton, Stack } from "@chase-sets/design-system";
import { DiscoveryShellLayout } from "@chase-sets/discovery/web";
import { resolveMarketplaceNavItems } from "../host";

type MarketplaceActor = {
  permissions?: readonly string[];
} | null;

function getActiveKey(pathname: string) {
  if (pathname.startsWith("/account/offers/matches")) {
    return "offer-matches";
  }

  if (pathname.startsWith("/account/offers/submitted")) {
    return "submitted-offers";
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
  const prompt = new URLSearchParams(location.search).get("authPrompt");
  const showAddPasskeyPrompt = Boolean(actor && prompt === "add-passkey");

  return (
    <DiscoveryShellLayout
      activeKey={getActiveKey(location.pathname)}
      topNavItems={topNavItems}
      bottomNavItems={bottomNavItems}
      actions={
        rootData?.actor ? (
          <form action="/sign-out" method="post">
            <Button type="submit" tone="secondary">
              {t("marketplace.app.routes.layout.sign.out")}</Button>
          </form>
        ) : null
      }
    >
      <Stack gap={4}>
        {showAddPasskeyPrompt ? (
          <Banner
            title={t("marketplace.app.routes.layout.add.passkey")}
            description={t("marketplace.app.routes.layout.add.passkey.description")}
            tone="accent"
            actions={
              <LinkButton href="/register" tone="secondary" size="sm" leadingIcon="shield">
                {t("marketplace.app.routes.layout.add.passkey.action")}</LinkButton>
            }
          />
        ) : null}
        <Outlet />
      </Stack>
    </DiscoveryShellLayout>
  );
}
