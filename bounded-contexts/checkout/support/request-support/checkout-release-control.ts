import type { CheckoutFreshStateMode } from "../../features/sessions/domain/fresh-state-route-strategy";
import {
  checkoutFreshStateFeatureKey,
  checkoutFreshStateKillSwitch,
} from "../../features/sessions/domain/fresh-state-route-strategy";
import { checkoutObservabilityTelemetryEvent } from "../../features/sessions/api/checkout-observability-telemetry";
import type { CheckoutObservabilityTelemetryEvent } from "../../features/sessions/api/checkout-observability-telemetry";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";

export type CheckoutRolloutEnvironment = "development" | "test" | "preview" | "staging" | "production";

type CheckoutReleaseActor =
  | Readonly<{
      accountId?: string | null;
      roleKey?: string | null;
      permissions?: readonly string[] | null;
    }>
  | null
  | undefined;

export type CheckoutShopifySimpleDecisionReason =
  | "deployment-kill-switch"
  | "platform-operations-kill-switch"
  | "platform-operations-disabled"
  | "platform-operations-unavailable"
  | "not-required";

export type CheckoutShopifySimpleDecision = Readonly<{
  enabled: boolean;
  reason: CheckoutShopifySimpleDecisionReason;
  source: "deployment" | "platform-operations" | "local-default";
}>;

export type CheckoutShopifySimpleUnavailableState = Readonly<{
  redirectPath: string;
  decision: CheckoutShopifySimpleDecision;
  telemetryEvent: CheckoutObservabilityTelemetryEvent;
}>;

type ReleaseControlDecision = Readonly<{
  enabled?: unknown;
  reason?: unknown;
}>;

type CheckoutReleaseEnvironment = Readonly<{
  CHASE_SETS_CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE?: string;
  DEPLOYMENT_ENVIRONMENT?: string;
  NODE_ENV?: string;
}>;

const activeEnvironmentValues = new Set(["1", "true", "yes", "on"]);
const rolloutEnvironments = ["development", "test", "preview", "staging", "production"] as const;

export function isCheckoutShopifySimpleDeploymentKillSwitchActive(env: CheckoutReleaseEnvironment = process.env) {
  return activeEnvironmentValues.has(
    String(env.CHASE_SETS_CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE ?? "")
      .trim()
      .toLowerCase(),
  );
}

export function normalizeCheckoutRolloutEnvironment(value: unknown): CheckoutRolloutEnvironment {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return rolloutEnvironments.find((candidate) => candidate === text) ?? "development";
}

function checkoutRolloutEnvironment(env: CheckoutReleaseEnvironment) {
  return normalizeCheckoutRolloutEnvironment(env.DEPLOYMENT_ENVIRONMENT ?? env.NODE_ENV);
}

function shouldReadPlatformOperationsDecision(environment: CheckoutRolloutEnvironment, actor: CheckoutReleaseActor) {
  return (
    (environment === "staging" || environment === "production") &&
    Boolean(actor?.accountId) &&
    actor?.roleKey !== "guest-buyer"
  );
}

function disabledRedirectPathForMode(mode: CheckoutFreshStateMode) {
  return mode === "sell"
    ? checkoutFreshStateKillSwitch.disabledSellEntryRedirectPath
    : checkoutFreshStateKillSwitch.disabledBuyEntryRedirectPath;
}

function actorMode(actor: CheckoutReleaseActor) {
  if (!actor) {
    return "anonymous";
  }

  return actor.roleKey === "guest-buyer" ? "guest" : "signed-in";
}

function killSwitchEntrySource(mode: CheckoutFreshStateMode) {
  return mode === "sell" ? "sell-list-readiness" : "buy-cart-readiness";
}

export function checkoutShopifySimpleUnavailableTelemetryEvent(
  mode: CheckoutFreshStateMode,
  actor: CheckoutReleaseActor,
  decision: CheckoutShopifySimpleDecision,
) {
  return checkoutObservabilityTelemetryEvent({
    state: "kill-switch-checkout-unavailable",
    entrySource: killSwitchEntrySource(mode),
    actorMode: actorMode(actor),
    scenarioState: "kill-switch",
    visibleState: "checkout-unavailable-visible",
    sideEffectStatus: "not-attempted",
    readinessContract: mode === "sell" ? "checkout.sell-list-readiness.v1" : "checkout.cart-readiness.v1",
    readinessSnapshotState: "not-created",
    sourceRevisionState: "not-read",
    freshWriteReceiptPresence: "not-provided",
    supportReferencePresent: false,
    performanceBudgetId: "checkout-kill-switch-entry",
    providerCategory: decision.source,
    riskCategory: "none",
    downstreamStatus: "not-started",
    launchRegisterDecision: "blocked",
    freshStateScanResult: "blocked-before-checkout",
    promotionDecision: decision.reason,
    releaseRunId: null,
  });
}

export async function evaluateCheckoutShopifySimpleDecision(
  request: Request,
  actor: CheckoutReleaseActor,
  options: Readonly<{
    env?: CheckoutReleaseEnvironment;
    fetch?: typeof globalThis.fetch;
    environment?: CheckoutRolloutEnvironment;
  }> = {},
): Promise<CheckoutShopifySimpleDecision> {
  const env = options.env ?? process.env;
  if (isCheckoutShopifySimpleDeploymentKillSwitchActive(env)) {
    return {
      enabled: false,
      reason: "deployment-kill-switch",
      source: "deployment",
    };
  }

  const environment = options.environment ?? checkoutRolloutEnvironment(env);
  if (!shouldReadPlatformOperationsDecision(environment, actor)) {
    return {
      enabled: true,
      reason: "not-required",
      source: "local-default",
    };
  }

  const query = new URLSearchParams({
    environment,
    subjectType: "account",
    subjectId: actor?.accountId ?? "",
  });
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/platform");

  try {
    const response = await createForwardedAuthFetch(request, options.fetch ?? globalThis.fetch, {
      readTargetContextName: "platform-operations",
    })(`${baseUrl}/release-controls/rollouts/${encodeURIComponent(checkoutFreshStateFeatureKey)}/decision?${query}`);

    if (!response.ok) {
      return {
        enabled: false,
        reason: "platform-operations-unavailable",
        source: "platform-operations",
      };
    }

    const decision = (await response.json().catch(() => null)) as ReleaseControlDecision | null;
    if (decision?.enabled === true) {
      return {
        enabled: true,
        reason: "not-required",
        source: "platform-operations",
      };
    }

    return {
      enabled: false,
      reason: decision?.reason === "kill-switch" ? "platform-operations-kill-switch" : "platform-operations-disabled",
      source: "platform-operations",
    };
  } catch {
    return {
      enabled: false,
      reason: "platform-operations-unavailable",
      source: "platform-operations",
    };
  }
}

export async function resolveCheckoutShopifySimpleUnavailableState(
  request: Request,
  actor: CheckoutReleaseActor,
  mode: CheckoutFreshStateMode,
  options: Readonly<{
    env?: CheckoutReleaseEnvironment;
    fetch?: typeof globalThis.fetch;
    environment?: CheckoutRolloutEnvironment;
  }> = {},
): Promise<CheckoutShopifySimpleUnavailableState | null> {
  const decision = await evaluateCheckoutShopifySimpleDecision(request, actor, options);
  if (decision.enabled) {
    return null;
  }

  return {
    redirectPath: disabledRedirectPathForMode(mode),
    decision,
    telemetryEvent: checkoutShopifySimpleUnavailableTelemetryEvent(mode, actor, decision),
  };
}
