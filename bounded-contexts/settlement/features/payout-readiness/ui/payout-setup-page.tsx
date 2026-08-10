import { t } from "@chase-sets/localization";
import {
  loadConnectAndInitialize,
  type ConnectElementTagName,
  type ConnectHTMLElementRecord,
} from "@stripe/connect-js/pure";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  HiddenInput,
  EmbeddedProviderSurface,
  Form,
  Badge,
  Banner,
  Button,
  Card,
  createStripeConnectAppearance,
  Inline,
  LinkButton,
  LoadingSpinner,
  observeStripeAppearance,
  Page,
  PageHeader,
  PageSection,
  ProgressiveDisclosure,
  Stack,
  stripeAppearanceSnapshot,
  Text,
} from "@chase-sets/design-system";
import type { SettlementPayoutReadinessRow } from "../read-model/queries";
import { buildMissingRequirementGroups, type MissingRequirementGroup } from "../domain/setup-progress";
import { PayoutReadinessPanel } from "./payout-readiness-panel";
import { StripeConnectNotificationBanner } from "./stripe-connect-notification-banner";

export type PayoutSetupMode = "setup" | "management";

type StripeConnectComponentName = Extract<ConnectElementTagName, "account-onboarding" | "account-management">;

type StripeConnectElement = HTMLElement & {
  setOnExit?: (callback: () => void) => void;
  setOnLoadError?: (callback: (loadError: { error?: { message?: string; type?: string } }) => void) => void;
  setOnLoaderStart?: (callback: () => void) => void;
};

type FetchClientSecret = () => Promise<string>;

export function loadStripeConnectComponent({
  mode,
  publishableKey,
  fetchClientSecret,
  contactEmail,
  appearanceScope = null,
}: {
  mode: PayoutSetupMode;
  publishableKey: string;
  fetchClientSecret?: FetchClientSecret;
  contactEmail?: string | null;
  appearanceScope?: Element | null;
}) {
  if (typeof window === "undefined") {
    throw new Error(t("settlement.features.payoutReadiness.ui.payoutSetupPage.connect.can.only.load.in.browser"));
  }

  return loadConnectAndInitialize({
    publishableKey,
    fetchClientSecret: fetchClientSecret ?? (() => fetchEmbeddedClientSecret(mode, contactEmail)),
    locale: "en-US",
    appearance: createStripeConnectAppearance({ scope: appearanceScope }),
  });
}

function embeddedEndpoint(mode: PayoutSetupMode) {
  return mode === "management"
    ? "/api/settlement/payout-setup/account-management-embedded-session"
    : "/api/settlement/payout-setup/embedded-session";
}

function setupSessionRequestBody(contactEmail?: string | null) {
  const normalizedContactEmail = contactEmail?.trim();

  return normalizedContactEmail ? JSON.stringify({ contactEmail: normalizedContactEmail }) : "{}";
}

/** The API's machine code for "this session did not authenticate recently enough". */
export const STEP_UP_REQUIRED_ERROR_CODE = "step_up_required";

/**
 * Carries the API's machine error code alongside its message so the surface can
 * offer re-authentication for `step_up_required` and only for that -- never for
 * a provider-authority failure, which re-authenticating cannot resolve.
 */
export class EmbeddedSessionError extends Error {
  public readonly code: string | null;

  public constructor(code: string | null, message: string) {
    super(message);
    this.name = "EmbeddedSessionError";
    this.code = code;
  }
}

export function isStepUpRequiredError(error: unknown): error is EmbeddedSessionError {
  return error instanceof EmbeddedSessionError && error.code === STEP_UP_REQUIRED_ERROR_CODE;
}

/**
 * The re-authentication target for this surface. The return path is one of the
 * two literal routes this page already owns (`modeHref`), never a value read
 * from the current location or the query string, so there is no attacker-
 * controlled input to sanitize and the destination is same-origin by
 * construction.
 */
export function reauthenticateHref(mode: PayoutSetupMode) {
  return `/sign-in?returnTo=${encodeURIComponent(modeHref(mode))}`;
}

export async function fetchEmbeddedClientSecret(mode: PayoutSetupMode, contactEmail?: string | null) {
  const response = await fetch(embeddedEndpoint(mode), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: setupSessionRequestBody(mode === "setup" ? contactEmail : null),
  });

  const body = (await response.json().catch(() => ({}))) as {
    clientSecret?: unknown;
    error?: { code?: unknown; message?: string };
  };

  if (!response.ok) {
    throw new EmbeddedSessionError(
      typeof body.error?.code === "string" ? body.error.code : null,
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
  fetchClientSecret?: FetchClientSecret,
  contactEmail?: string | null,
  appearanceScope?: Element | null,
): ConnectHTMLElementRecord[StripeConnectComponentName] {
  return loadStripeConnectComponent({ mode, publishableKey, fetchClientSecret, contactEmail, appearanceScope }).create(
    componentName(mode),
  );
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
  return mode === "management" ? "/account/desk/settings?mode=manage" : "/account/desk/settings";
}

function requirementGroupLabel(group: MissingRequirementGroup) {
  switch (group.id) {
    case "payout-account":
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.payout.account");
    case "identity-and-business":
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.identity.and.business.details");
    case "account-agreement":
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.account.agreement");
    case "platform-review":
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.platform.review");
    default:
      return t("settlement.features.payoutReadiness.ui.payoutSetupPage.verification.review");
  }
}

export function StripeConnectEmbeddedComponent({
  mode,
  publishableKey,
  onProviderExit,
  contactEmail,
}: {
  mode: PayoutSetupMode;
  publishableKey: string | null;
  onProviderExit?: () => void;
  contactEmail?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const componentRef = useRef<StripeConnectElement | null>(null);
  const [appearanceScope, setAppearanceScope] = useState<HTMLDivElement | null>(null);
  const [appearanceVersion, setAppearanceVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "visible" | "error" | "step-up">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

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
      return;
    }

    if (!appearanceScope || appearanceVersion === null) {
      return;
    }

    let cancelled = false;
    let mountedComponent: StripeConnectElement | null = null;
    setStatus("loading");
    setErrorMessage(null);

    const mount = async () => {
      const clientSecret = await fetchEmbeddedClientSecret(mode, contactEmail);
      let preflightClientSecretAvailable = true;
      if (cancelled || containerRef.current !== appearanceScope) {
        return;
      }

      const component = createStripeConnectElement(
        mode,
        publishableKey,
        async () => {
          if (preflightClientSecretAvailable) {
            preflightClientSecretAvailable = false;
            return clientSecret;
          }

          return fetchEmbeddedClientSecret(mode, contactEmail);
        },
        contactEmail,
        appearanceScope,
      ) as StripeConnectElement;

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

      appearanceScope.replaceChildren(component);
      componentRef.current = component;
      mountedComponent = component;
      setStatus("visible");
    };

    mount().catch((error) => {
      if (cancelled) {
        return;
      }

      // A stale session is a distinct outcome from a failed load: the remedy is
      // re-authentication and a retry of session creation, not support. Every
      // other failure -- including a provider-authority failure -- keeps the
      // existing retry/support affordance.
      if (isStepUpRequiredError(error)) {
        setStatus("step-up");
        setErrorMessage(error.message);
        return;
      }

      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
      mountedComponent?.remove();
      if (componentRef.current === mountedComponent) {
        componentRef.current = null;
      }
      appearanceScope.replaceChildren();
    };
  }, [appearanceScope, appearanceVersion, contactEmail, mode, onProviderExit, publishableKey, retryCount]);

  return (
    <Stack gap={3}>
      {status === "loading" ? (
        <LoadingSpinner label={t("settlement.features.payoutReadiness.ui.payoutSetupPage.loading.secure.setup")} />
      ) : null}
      {status === "step-up" ? (
        <Banner
          tone="warning"
          title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.confirm.it.is.you")}
          description={
            errorMessage ?? t("settlement.features.payoutReadiness.ui.payoutSetupPage.sign.in.again.to.manage.payouts")
          }
          actions={
            <Inline>
              <LinkButton href={reauthenticateHref(mode)}>
                {t("settlement.features.payoutReadiness.ui.payoutSetupPage.sign.in.again")}
              </LinkButton>
              <Button type="button" tone="secondary" onClick={() => setRetryCount((value) => value + 1)}>
                {t("settlement.features.payoutReadiness.ui.payoutSetupPage.retry")}
              </Button>
            </Inline>
          }
        />
      ) : null}
      {status === "error" ? (
        <Banner
          tone="warning"
          title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.setup.could.not.load")}
          description={
            errorMessage ?? t("settlement.features.payoutReadiness.ui.payoutSetupPage.setup.session.may.have.expired")
          }
          actions={
            <Inline>
              <Button type="button" tone="secondary" onClick={() => setRetryCount((value) => value + 1)}>
                {t("settlement.features.payoutReadiness.ui.payoutSetupPage.retry")}
              </Button>
              <LinkButton href="/account/support" tone="secondary">
                {t("settlement.features.payoutReadiness.ui.payoutSetupPage.contact.support")}
              </LinkButton>
            </Inline>
          }
        />
      ) : null}
      <EmbeddedProviderSurface
        ref={setContainer}
        aria-label={providerPanelTitle(mode)}
        data-testid="stripe-connect-embedded-component"
      />
    </Stack>
  );
}

export function PayoutSetupPage({
  payoutReadiness,
  mode,
  stripePublishableKey,
  contactEmail = null,
  setupNotice = null,
  providerErrorMessage = null,
  onProviderExit,
}: {
  payoutReadiness: SettlementPayoutReadinessRow;
  mode: PayoutSetupMode;
  stripePublishableKey: string | null;
  contactEmail?: string | null;
  setupNotice?: string | null;
  providerErrorMessage?: string | null;
  onProviderExit?: () => void;
}) {
  const hasProviderAccount = Boolean(payoutReadiness.provider_reference);
  const missingRequirementGroups = buildMissingRequirementGroups(payoutReadiness.missing_requirements);
  const hasSellerActionableRequirement = missingRequirementGroups.some((group) => group.id !== "platform-review");
  const canRenderProviderComponent =
    mode === "setup"
      ? payoutReadiness.status !== "ready" && (missingRequirementGroups.length === 0 || hasSellerActionableRequirement)
      : hasProviderAccount;
  const missingRequirementCount = missingRequirementGroups.reduce((count, group) => count + group.count, 0);
  const showSupportEscalation =
    payoutReadiness.status === "restricted" || providerErrorMessage !== null || missingRequirementCount > 0;

  return (
    <Page>
      <PageHeader
        eyebrow={t("settlement.features.payoutReadiness.ui.payoutSetupPage.settlement")}
        title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.payout.setup")}
        description={t("settlement.features.payoutReadiness.ui.payoutSetupPage.keep.your.payout.destination")}
        actions={
          <Stack direction="row" gap={2}>
            <LinkButton href="/account/desk/money" tone="secondary">
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

      {hasProviderAccount ? (
        <PageSection title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.payout.notifications")}>
          <Card>
            <StripeConnectNotificationBanner publishableKey={stripePublishableKey} />
          </Card>
        </PageSection>
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
              showSupportEscalation={showSupportEscalation}
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
                  {missingRequirementGroups.map((group) => (
                    <Text key={group.id} size="sm" tone="secondary">
                      {requirementGroupLabel(group)}:{" "}
                      {t("settlement.features.payoutReadiness.ui.payoutSetupPage.requirement.group.count", {
                        count: String(group.count),
                      })}
                    </Text>
                  ))}
                </Stack>
              </ProgressiveDisclosure>
            ) : null}
            <Form spacing="none" method="post">
              <HiddenInput type="hidden" name="intent" value="refresh-payout-setup" />
              <HiddenInput type="hidden" name="mode" value={mode} />
              <Button type="submit" tone="secondary">
                {t("settlement.features.payoutReadiness.ui.payoutSetupPage.refresh.setup.status")}
              </Button>
            </Form>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={providerPanelTitle(mode)}>
        <Card overflow="visible">
          <Stack gap={3}>
            {providerErrorMessage ? (
              <Banner
                tone="warning"
                title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.setup.could.not.load")}
                description={t("settlement.features.payoutReadiness.ui.payoutSetupPage.setup.load.failed.with.reason", {
                  reason: providerErrorMessage,
                })}
                actions={
                  <Inline>
                    <LinkButton href={modeHref(mode)} tone="secondary">
                      {t("settlement.features.payoutReadiness.ui.payoutSetupPage.retry")}
                    </LinkButton>
                    <LinkButton href="/account/support" tone="secondary">
                      {t("settlement.features.payoutReadiness.ui.payoutSetupPage.contact.support")}
                    </LinkButton>
                  </Inline>
                }
              />
            ) : null}
            {canRenderProviderComponent ? (
              <StripeConnectEmbeddedComponent
                mode={mode}
                publishableKey={stripePublishableKey}
                onProviderExit={onProviderExit}
                contactEmail={contactEmail}
              />
            ) : (
              <Banner
                tone="success"
                title={t("settlement.features.payoutReadiness.ui.payoutSetupPage.payouts.are.ready")}
                description={t("settlement.features.payoutReadiness.ui.payoutSetupPage.you.can.request.payouts")}
                actions={
                  <LinkButton href="/account/desk/money">
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
