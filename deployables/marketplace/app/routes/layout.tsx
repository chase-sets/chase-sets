import { t } from "@chase-sets/localization";
import { useEffect, useState } from "react";
import { Outlet, redirect, useLocation, useRouteLoaderData, type LoaderFunctionArgs } from "react-router";
import { AccountMenu, Banner, Button, Form, LinkButton, Stack, type ColorMode } from "@chase-sets/design-system";
import { DiscoveryShellLayout } from "@chase-sets/discovery/web";
import type { CurrentActorDisplay } from "@chase-sets/identity/server";
import { useUserPreferencesAccountMenu } from "@chase-sets/identity/web";
import { resolveLegacyNotificationCenterHref } from "@chase-sets/notifications/web";
import { resolveMarketplaceAccountMenuItems, resolveMarketplaceNavItems } from "../host";

const signOutFormId = "marketplace-account-menu-sign-out";

type MarketplaceActor = {
  permissions?: readonly string[];
  roleKey?: string | null;
} | null;

// Retired notification-sheet links (`?notifications=feed|settings`) on any page in this
// layout now resolve to the Notifications-owned account route.
export function loader({ request }: LoaderFunctionArgs) {
  const notificationCenterHref = resolveLegacyNotificationCenterHref(new URL(request.url));
  return notificationCenterHref ? redirect(notificationCenterHref) : null;
}

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

  if (pathname.startsWith("/account/notifications")) {
    return "notifications";
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
        colorMode?: ColorMode;
        viewer?: {
          preferences?: {
            colorMode?: ColorMode;
            reducedMotion?: "user" | "always" | "never";
          } | null;
        } | null;
      }
    | undefined;
  const { colorMode, preferences } = useUserPreferencesAccountMenu(
    rootData?.viewer?.preferences?.colorMode ?? rootData?.colorMode,
  );
  const actor = rootData?.actor ?? null;
  const isGuestCheckoutActor = actor?.roleKey === "guest-buyer";
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
  const accountMenuItems = resolveMarketplaceAccountMenuItems(actor);
  const prompt = new URLSearchParams(location.search).get("authPrompt");
  const showAddPasskeyPrompt = Boolean(actor && !isGuestCheckoutActor && prompt === "add-passkey");
  return (
    <DiscoveryShellLayout
      activeKey={getActiveKey(location.pathname)}
      colorMode={colorMode}
      reducedMotion={rootData?.viewer?.preferences?.reducedMotion}
      topNavItems={topNavItems}
      bottomNavItems={bottomNavItems}
      actions={
        rootData?.actor ? (
          <>
            {isGuestCheckoutActor ? (
              <Form action="/guest-checkout/exit" method="post" spacing="none">
                <Button type="submit" tone="secondary">
                  {t("marketplace.app.routes.layout.exit.guest.checkout")}
                </Button>
              </Form>
            ) : rootData.actorDisplay ? (
              <>
                <Form id={signOutFormId} action="/sign-out" method="post" spacing="none" hidden />
                <AccountMenu
                  menuLabel={t("identity.features.accounts.ui.currentActorDisplayCue.account.menu")}
                  accountLabel={t("identity.features.accounts.ui.currentActorDisplayCue.account")}
                  accountName={displayActorAccountName(rootData.actorDisplay)}
                  userLabel={t("identity.features.accounts.ui.currentActorDisplayCue.user")}
                  userName={displayActorUserName(rootData.actorDisplay)}
                  roleLabel={t("identity.features.accounts.ui.currentActorDisplayCue.role")}
                  roleName={displayRole(rootData.actorDisplay.membership.role_key)}
                  items={accountMenuItems}
                  preferences={preferences}
                  signOutFormId={signOutFormId}
                  signOutLabel={t("marketplace.app.routes.layout.sign.out")}
                />
              </>
            ) : (
              <Form action="/sign-out" method="post" spacing="none">
                <Button type="submit" tone="secondary">
                  {t("marketplace.app.routes.layout.sign.out")}
                </Button>
              </Form>
            )}
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
                {t("marketplace.app.routes.layout.add.passkey.action")}
              </LinkButton>
            }
          />
        ) : null}
        <Outlet />
      </Stack>
    </DiscoveryShellLayout>
  );
}
