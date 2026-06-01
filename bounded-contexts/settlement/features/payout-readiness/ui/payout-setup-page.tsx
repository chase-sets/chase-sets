import { t } from "@chase-sets/localization";
import {
  loadConnectAndInitialize,
  type ConnectElementTagName,
  type ConnectHTMLElementRecord,
} from "@stripe/connect-js/pure";
import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  LinkButton,
  LoadingSpinner,
  Page,
  PageHeader,
  PageSection,
  ProgressiveDisclosure,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { SettlementPayoutReadinessRow } from "../read-model/queries";
import { PayoutReadinessPanel } from "./payout-readiness-panel";

export type PayoutSetupMode = "setup" | "management";

type StripeConnectComponentName = Extract<ConnectElementTagName, "account-onboarding" | "account-management">;

type StripeConnectElement = HTMLElement & {
  setOnExit?: (callback: () => void) => void;
  setOnLoadError?: (callback: (loadError: { error?: { message?: string; type?: string } }) => void) => void;
  setOnLoaderStart?: (callback: () => void) => void;
};

export function loadStripeConnectComponent({
  mode,
  publishableKey,
}: {
  mode: PayoutSetupMode;
  publishableKey: string;
}) {
  if (typeof window === "undefined") {
    throw new Error(t("settlement.features.payoutReadiness.ui.payoutSetupPage.connect.can.only.load.in.browser"));
  }

  return loadConnectAndInitialize({
    publishableKey,
    fetchClientSecret: () => fetchEmbeddedClientSecret(mode),
    locale: "en-US",
    appearance: {
      overlays: "dialog",
      variables: {
        fontFamily: "inherit",
      },
    },
  });
}

function embeddedEndpoint(mode: PayoutSetupMode) {
  return mode === "management"
    ? "/api/settlement/payout-setup/account-management-embedded-session"
    : "/api/settlement/payout-setup/embedded-session";
}

export async function fetchEmbeddedClientSecret(mode: PayoutSetupMode) {
  const response = await fetch(embeddedEndpoint(mode), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  const body = (await response.json().catch(() => ({}))) as {
    clientSecret?: unknown;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(
      body.error?.message ?? t("settlement.features.payoutReadiness.ui.payoutSetupPage.session.could.not.be.created"),
    );
  }

  if (typeof body.clientSecret !== "string" || body.clientSecret.trim() === "") {
    throw new Error(t("settlement.features.payoutReadiness.ui.payoutSetupPage.session.was.missing.secret"));
  }

  return body.clientSecret;
}

function componentName(mode: PayoutSetupMode): StripeConnectComponentName {
  return mode === "management" ? "account-management" : "account-onboarding";
}

function createStripeConnectElement(
  mode: PayoutSetupMode,
  publishableKey: string,
): ConnectHTMLElementRecord[StripeConnectComponentName] {
  return loadStripeConnectComponent({ mode, publishableKey }).create(componentName(mode));
}

function providerPanelTitle(mode: PayoutSetupMode) {
  return mode === "management"
    ? t("settlement.features.payoutReadiness.ui.payoutSetupPage.manage.payout.details")
    : t("settlement.features.payoutReadiness.ui.payoutSetupPage.complete.payout.setup");
}

function providerPanelDescription(mode: PayoutSetupMode) {
  return mode === "management"
    ? t("settlement.features.payoutReadiness.ui.payoutSetupPage.review.or.update.the.details")
    : t("settlement.features.payoutReadiness.ui.payoutSetupPage.add.the.required.account.and");
}

function statusHeadline(status: SettlementPayoutReadinessRow["status"]) {
  switch (status) {
    case "ready":
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.payout.setup.is.ready");
    case "restricted":
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.payout.setup.needs.attention");
    case "not-started":
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.start.payout.setup");
    default:
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.finish.payout.setup");
  }
}

function statusTone(status: SettlementPayoutReadinessRow["status"]) {
  switch (status) {
    case "ready":
      return "success" as const;
    case "restricted":
      return "danger" as const;
    case "not-started":
      return "neutral" as const;
    default:
      return "warning" as const;
  }
}

function statusLabel(status: SettlementPayoutReadinessRow["status"]) {
  switch (status) {
    case "ready":
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.ready");
    case "restricted":
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.needs.attention");
    case "not-started":
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.not.started");
    default:
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.in.progress");
  }
}

function modeHref(mode: PayoutSetupMode) {
  return mode === "management" ? "/account/payouts/setup?mode=manage" : "/account/payouts/setup";
}

export function StripeConnectEmbeddedComponent({
  mode,
  publishableKey,
  onProviderExit,
}: {
  mode: PayoutSetupMode;
  publishableKey: string | null;
  onProviderExit?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const componentRef = useRef<StripeConnectElement | null>(null);
  const [status, setStatus] = useState<"loading" | "visible" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!publishableKey) {
      setStatus("error");
      setErrorMessage(t("settlement.features.payoutReadiness.ui.payoutSetupPage.provider.setup.is.not.configured"));
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setErrorMessage(null);

    const mount = async () => {
      const component = createStripeConnectElement(mode, publishableKey) as StripeConnectElement;
      if (cancelled || !containerRef.current) {
        return;
      }

      component.setOnLoaderStart?.(() => {
        if (!cancelled) {
          setStatus("visible");
        }
      });
      component.setOnLoadError?.((loadError) => {
        if (!cancelled) {
          setStatus("error");
          setErrorMessage(
            loadError.error?.message ??
              t("settlement.features.payoutReadiness.ui.payoutSetupPage.provider.component.could.not.load"),
          );
        }
      });
      component.setOnExit?.(() => {
        onProviderExit?.();
      });

      containerRef.current.replaceChildren(component);
      componentRef.current = component;
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
      componentRef.current?.remove();
      componentRef.current = null;
      containerRef.current?.replaceChildren();
    };
  }, [mode, onProviderExit, publishableKey, retryCount]);

  return (
    <Stack gap={3}>
      {status === "loading" ? (
        <LoadingSpinner label={t("settlement.features.payoutReadiness.ui.payoutSetupPage.loading.secure.setup")} />
      ) : null}
      {status === "error" ? (
        <Banner
          tone="warning"
          title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.setup.could.not.load")}
          description={errorMessage}
          actions={
            <Button type="button" tone="secondary" onClick={() => setRetryCount((value) => value + 1)}>
              {t("settlement.features.payoutReadiness.ui.payoutSetupPage.retry")}
            </Button>
          }
        />
      ) : null}
      <div ref={containerRef} aria-label={providerPanelTitle(mode)} data-testid="stripe-connect-embedded-component" />
    </Stack>
  );
}

export function PayoutSetupPage({
  payoutReadiness,
  mode,
  stripePublishableKey,
  setupNotice = null,
  providerErrorMessage = null,
  onProviderExit,
}: {
  payoutReadiness: SettlementPayoutReadinessRow;
  mode: PayoutSetupMode;
  stripePublishableKey: string | null;
  setupNotice?: string | null;
  providerErrorMessage?: string | null;
  onProviderExit?: () => void;
}) {
  const hasProviderAccount = Boolean(payoutReadiness.provider_reference);
  const canRenderProviderComponent = mode === "setup" ? payoutReadiness.status !== "ready" : hasProviderAccount;
  const missingRequirementCount = payoutReadiness.missing_requirements.length;

  return (
    <Page>
      <PageHeader
        eyebrow={t("settlement.features.payoutReadiness.ui.payoutSetupPage.settlement")}
        title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.payout.setup")}
        description={t("settlement.features.payoutReadiness.ui.payoutSetupPage.keep.your.payout.destination")}
        actions={
          <Stack direction="row" gap={2}>
            <LinkButton href="/account/payouts" tone="secondary">
              {t("settlement.features.payoutReadiness.ui.payoutSetupPage.back.to.payouts")}
            </LinkButton>
            {hasProviderAccount ? (
              <LinkButton href={modeHref(mode === "management" ? "setup" : "management")} tone="secondary">
                {mode === "management"
                  ? t("settlement.features.payoutReadiness.ui.payoutSetupPage.setup.view")
                  : t("settlement.features.payoutReadiness.ui.payoutSetupPage.manage.details")}
              </LinkButton>
            ) : null}
          </Stack>
        }
      />

      {setupNotice ? (
        <Banner
          tone="success"
          title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.setup.status.checked")}
          description={setupNotice}
        />
      ) : null}

      <PageSection title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.current.status")}>
        <Card>
          <Stack gap={4}>
            <Stack gap={2}>
              <Badge tone={statusTone(payoutReadiness.status)}>{statusLabel(payoutReadiness.status)}</Badge>
              <Text weight="semibold">{statusHeadline(payoutReadiness.status)}</Text>
              <Text size="sm" tone="secondary">
                {providerPanelDescription(mode)}
              </Text>
            </Stack>
            <PayoutReadinessPanel
              payoutReadiness={payoutReadiness}
              readyDescription={t(
                "settlement.features.payoutReadiness.ui.payoutSetupPage.payout.setup.is.complete.and.available",
              )}
            />
            {missingRequirementCount > 0 ? (
              <ProgressiveDisclosure
                title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.support.details")}
                summary={t("settlement.features.payoutReadiness.ui.payoutSetupPage.requirement.count", {
                  count: String(missingRequirementCount),
                })}
                tone="info"
              >
                <Stack gap={1}>
                  {payoutReadiness.missing_requirements.map((requirement) => (
                    <Text key={requirement} size="sm" tone="secondary">
                      {requirement}
                    </Text>
                  ))}
                </Stack>
              </ProgressiveDisclosure>
            ) : null}
            <form method="post">
              <input type="hidden" name="intent" value="refresh-payout-setup" />
              <input type="hidden" name="mode" value={mode} />
              <Button type="submit" tone="secondary">
                {t("settlement.features.payoutReadiness.ui.payoutSetupPage.refresh.setup.status")}
              </Button>
            </form>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={providerPanelTitle(mode)}>
        <Card>
          <Stack gap={3}>
            {providerErrorMessage ? (
              <Banner
                tone="warning"
                title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.setup.could.not.load")}
                description={providerErrorMessage}
                actions={
                  <LinkButton href={modeHref(mode)} tone="secondary">
                    {t("settlement.features.payoutReadiness.ui.payoutSetupPage.retry")}
                  </LinkButton>
                }
              />
            ) : null}
            {canRenderProviderComponent ? (
              <StripeConnectEmbeddedComponent
                mode={mode}
                publishableKey={stripePublishableKey}
                onProviderExit={onProviderExit}
              />
            ) : (
              <Banner
                tone="success"
                title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.payouts.are.ready")}
                description={t("settlement.features.payoutReadiness.ui.payoutSetupPage.you.can.request.payouts")}
                actions={
                  <LinkButton href="/account/payouts">
                    {t("settlement.features.payoutReadiness.ui.payoutSetupPage.request.payout")}
                  </LinkButton>
                }
              />
            )}
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
