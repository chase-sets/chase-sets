import { t } from "@chase-sets/localization";
import { loadConnectAndInitialize, type ConnectHTMLElementRecord } from "@stripe/connect-js/pure";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  EmbeddedProviderSurface,
  Banner,
  createStripeConnectAppearance,
  LoadingSpinner,
  observeStripeAppearance,
  Stack,
  stripeAppearanceSnapshot,
} from "@chase-sets/design-system";

type StripeConnectNotificationBannerElement = ConnectHTMLElementRecord["notification-banner"];

export async function fetchNotificationBannerClientSecret() {
  const response = await fetch("/api/settlement/payout-setup/notification-banner-session", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = (await response.json().catch(() => ({}))) as {
    clientSecret?: unknown;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(
      body.error?.message ??
        t("settlement.features.payoutReadiness.ui.payoutSetupPage.notification.banner.could.not.be.created"),
    );
  }

  if (typeof body.clientSecret !== "string" || body.clientSecret.trim() === "") {
    throw new Error(t("settlement.features.payoutReadiness.ui.payoutSetupPage.session.was.missing.secret"));
  }

  return body.clientSecret;
}

export function StripeConnectNotificationBanner({ publishableKey }: { publishableKey: string | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const componentRef = useRef<StripeConnectNotificationBannerElement | null>(null);
  const [appearanceScope, setAppearanceScope] = useState<HTMLDivElement | null>(null);
  const [appearanceVersion, setAppearanceVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "visible" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const setContainer = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    setAppearanceScope(node);
    setAppearanceVersion(node ? stripeAppearanceSnapshot({ scope: node }) : null);
  }, []);

  useEffect(() => {
    if (!appearanceScope) {
      return undefined;
    }

    return observeStripeAppearance({ scope: appearanceScope }, () => {
      setAppearanceVersion(stripeAppearanceSnapshot({ scope: appearanceScope }));
    });
  }, [appearanceScope]);

  useEffect(() => {
    if (!publishableKey) {
      setStatus("error");
      setErrorMessage(t("settlement.features.payoutReadiness.ui.payoutSetupPage.provider.setup.is.not.configured"));
      return undefined;
    }

    if (!appearanceScope || appearanceVersion === null) {
      return undefined;
    }

    let cancelled = false;
    let mountedComponent: StripeConnectNotificationBannerElement | null = null;
    setStatus("loading");
    setErrorMessage(null);

    const mount = async () => {
      const clientSecret = await fetchNotificationBannerClientSecret();
      let preflightClientSecretAvailable = true;
      if (cancelled || containerRef.current !== appearanceScope) {
        return;
      }

      const connect = loadConnectAndInitialize({
        publishableKey,
        fetchClientSecret: async () => {
          if (preflightClientSecretAvailable) {
            preflightClientSecretAvailable = false;
            return clientSecret;
          }

          return fetchNotificationBannerClientSecret();
        },
        locale: "en-US",
        appearance: createStripeConnectAppearance({ scope: appearanceScope }),
      });
      const component = connect.create("notification-banner");
      component.setOnLoaderStart(() => {
        if (!cancelled) {
          setStatus("visible");
        }
      });
      component.setOnLoadError(({ error }) => {
        if (!cancelled) {
          setStatus("error");
          setErrorMessage(
            error?.message ??
              t("settlement.features.payoutReadiness.ui.payoutSetupPage.notification.banner.could.not.load.detail"),
          );
        }
      });

      appearanceScope.replaceChildren(component);
      componentRef.current = component;
      mountedComponent = component;
      setStatus("visible");
    };

    mount().catch((error) => {
      if (!cancelled) {
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    });

    return () => {
      cancelled = true;
      mountedComponent?.remove();
      if (componentRef.current === mountedComponent) {
        componentRef.current = null;
      }
      appearanceScope.replaceChildren();
    };
  }, [appearanceScope, appearanceVersion, publishableKey]);

  return (
    <Stack gap={2}>
      {status === "loading" ? (
        <LoadingSpinner
          label={t("settlement.features.payoutReadiness.ui.payoutSetupPage.notification.banner.loading")}
        />
      ) : null}
      {status === "error" ? (
        <Banner
          tone="warning"
          title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.notification.banner.could.not.load")}
          description={errorMessage}
        />
      ) : null}
      <EmbeddedProviderSurface
        ref={setContainer}
        aria-label={t("settlement.features.payoutReadiness.ui.payoutSetupPage.notification.banner.aria.label")}
        data-testid="stripe-connect-notification-banner"
      />
    </Stack>
  );
}
