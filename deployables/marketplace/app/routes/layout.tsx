import { t } from "@chase-sets/localization";
import { useEffect, useState } from "react";
import { Outlet, useLocation, useRouteLoaderData } from "react-router";
import { ActorIdentityCue, Banner, Button, LinkButton, Stack } from "@chase-sets/design-system";
import { DiscoveryShellLayout } from "@chase-sets/discovery/web";
import type { CurrentActorDisplay } from "@chase-sets/identity/server";
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

  if (pathname.startsWith("/account/payouts")) {
    return "payouts";
  }

  if (pathname.startsWith("/account/settlement")) {
    return "wallet";
  }

  if (pathname.startsWith("/account/purchases")) {
    return "purchases";
  }

  if (pathname.startsWith("/account/product-alerts")) {
    return "product-alerts";
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

function displayActorAccountName(display: CurrentActorDisplay) {
  return display.account.display_name ?? display.account.name ?? display.account.account_id;
}

function displayActorUserName(display: CurrentActorDisplay) {
  return display.user.display_name ?? display.user.primary_email ?? display.user.user_id;
}

function displayRole(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function MarketplaceLayoutRoute() {
  const location = useLocation();
  const rootData = useRouteLoaderData("root") as
    | {
        actor?: MarketplaceActor;
        actorDisplay?: CurrentActorDisplay | null;
        cartCount?: number;
      }
    | undefined;
  const actor = rootData?.actor ?? null;
  const [cartCount, setCartCount] = useState(rootData?.cartCount ?? 0);
  useEffect(() => {
    setCartCount(rootData?.cartCount ?? 0);
  }, [rootData?.cartCount]);
  useEffect(() => {
    const handleCartCountChanged = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        return;
      }

      const countDelta = Number(event.detail?.countDelta ?? 0);
      const count = Number(event.detail?.count ?? Number.NaN);
      setCartCount((current) =>
        Number.isFinite(count)
          ? Math.max(0, count)
          : Math.max(0, current + (Number.isFinite(countDelta) ? countDelta : 0)),
      );
    };

    window.addEventListener("chase-sets:cart-count-changed", handleCartCountChanged);
    return () => {
      window.removeEventListener("chase-sets:cart-count-changed", handleCartCountChanged);
    };
  }, []);
  const topNavItems = resolveMarketplaceNavItems("top-nav", actor, { cartCount });
  const bottomNavItems = resolveMarketplaceNavItems("bottom-nav", actor, { cartCount });
  const prompt = new URLSearchParams(location.search).get("authPrompt");
  const showAddPasskeyPrompt = Boolean(actor && prompt === "add-passkey");

  return (
    <DiscoveryShellLayout
      activeKey={getActiveKey(location.pathname)}
      topNavItems={topNavItems}
      bottomNavItems={bottomNavItems}
      actions={
        rootData?.actor ? (
          <>
            {rootData.actorDisplay ? (
              <ActorIdentityCue
                title={t("identity.features.accounts.ui.currentActorDisplayCue.signed.in.identity")}
                accountLabel={t("identity.features.accounts.ui.currentActorDisplayCue.acting.as")}
                accountName={displayActorAccountName(rootData.actorDisplay)}
                userLabel={t("identity.features.accounts.ui.currentActorDisplayCue.signed.in.as")}
                userName={displayActorUserName(rootData.actorDisplay)}
                membershipLabel={t("identity.features.accounts.ui.currentActorDisplayCue.membership")}
                membershipName={displayRole(rootData.actorDisplay.membership.role_key)}
                className="hidden md:flex"
              />
            ) : null}
            <form action="/sign-out" method="post">
              <Button type="submit" tone="secondary">
                {t("marketplace.app.routes.layout.sign.out")}</Button>
            </form>
          </>
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
