import type { DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";

export type {
  PaymentsCheckoutStatus,
  PaymentsCheckoutRecoveryOptions,
  PaymentsAccountOrderInput,
  PaymentsMarketplaceCheckoutFeePolicy,
  PaymentsPaymentDetail,
} from "../ui/contracts";

/**
 * Boot-time effective classification of the platform payment provider configuration. The value is
 * decided by the platform configuration loader and transported here; Payments never derives it.
 */
export const PAYMENT_PROVIDER_MODES = ["unconfigured", "test", "live"] as const;

export type PaymentProviderMode = (typeof PAYMENT_PROVIDER_MODES)[number];

export const PAYMENT_PROVIDER_GATEWAY_KINDS = ["stripe", "fake"] as const;

export type PaymentProviderGatewayKind = (typeof PAYMENT_PROVIDER_GATEWAY_KINDS)[number];

/**
 * The closed deployment-environment vocabulary this response may report. It is constrained to the
 * platform declaration at compile time and asserted equal to it at test time, so the two cannot
 * drift apart while this file stays free of runtime platform imports.
 */
export const PAYMENT_PROVIDER_DEPLOYMENT_ENVIRONMENTS = [
  "production",
  "staging",
  "preview",
  "test",
  "dev",
  "local",
  "remote-dev",
] as const satisfies readonly DeploymentEnvironment[];

/**
 * The immutable configuration-time record supplied once per process by the API host. Every member is
 * decided when the host loads its configuration; none of them is request-scoped.
 */
export type ProviderModeObservation = Readonly<{
  mode: PaymentProviderMode;
  paymentProcessorKind: PaymentProviderGatewayKind;
  moneyMovementKind: PaymentProviderGatewayKind;
  deploymentEnvironment: DeploymentEnvironment;
}>;

/** The observation plus the one request-time instant the handler adds. */
export type PaymentProviderModeResponse = ProviderModeObservation &
  Readonly<{
    observedAt: string;
  }>;

const PROVIDER_MODE_OBSERVATION_MEMBERS = [
  "mode",
  "paymentProcessorKind",
  "moneyMovementKind",
  "deploymentEnvironment",
] as const;

export const PAYMENT_PROVIDER_MODE_RESPONSE_MEMBERS = [...PROVIDER_MODE_OBSERVATION_MEMBERS, "observedAt"] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function hasExactlyMembers(value: Readonly<Record<string, unknown>>, members: readonly string[]) {
  const presentKeys = Object.keys(value);
  return presentKeys.length === members.length && members.every((member) => presentKeys.includes(member));
}

function isPaymentProviderMode(value: unknown): value is PaymentProviderMode {
  return typeof value === "string" && PAYMENT_PROVIDER_MODES.some((member) => member === value);
}

function isPaymentProviderGatewayKind(value: unknown): value is PaymentProviderGatewayKind {
  return typeof value === "string" && PAYMENT_PROVIDER_GATEWAY_KINDS.some((member) => member === value);
}

function isDeploymentEnvironment(value: unknown): value is DeploymentEnvironment {
  return typeof value === "string" && PAYMENT_PROVIDER_DEPLOYMENT_ENVIRONMENTS.some((member) => member === value);
}

/**
 * A timezone-bearing RFC 3339 instant. A date-only value and an offset-less local timestamp are both
 * refused, because neither names the instant it claims to report.
 */
function isTimezoneBearingInstant(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(
    value,
  );
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }

  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
  const maximumDay = daysInMonth[month - 1];
  if (maximumDay === undefined || day < 1 || day > maximumDay) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
}

/**
 * Closes the observation recursively. Unknown, extra, missing and out-of-enum members are refused, as
 * is a gateway pair that contradicts the mode it is reported with.
 */
export function parseProviderModeObservation(value: unknown): ProviderModeObservation | null {
  if (!isRecord(value) || !hasExactlyMembers(value, PROVIDER_MODE_OBSERVATION_MEMBERS)) {
    return null;
  }

  const mode = value.mode;
  const paymentProcessorKind = value.paymentProcessorKind;
  const moneyMovementKind = value.moneyMovementKind;
  const deploymentEnvironment = value.deploymentEnvironment;

  if (
    !isPaymentProviderMode(mode) ||
    !isPaymentProviderGatewayKind(paymentProcessorKind) ||
    !isPaymentProviderGatewayKind(moneyMovementKind) ||
    !isDeploymentEnvironment(deploymentEnvironment)
  ) {
    return null;
  }

  const bothGatewaysFake = paymentProcessorKind === "fake" && moneyMovementKind === "fake";
  if (bothGatewaysFake !== (mode === "unconfigured")) {
    return null;
  }

  return { mode, paymentProcessorKind, moneyMovementKind, deploymentEnvironment };
}

/** Closes the served response, including the request-time instant the handler adds. */
export function parsePaymentProviderModeResponse(value: unknown): PaymentProviderModeResponse | null {
  if (!isRecord(value) || !hasExactlyMembers(value, PAYMENT_PROVIDER_MODE_RESPONSE_MEMBERS)) {
    return null;
  }

  const observedAt = value.observedAt;
  if (!isTimezoneBearingInstant(observedAt)) {
    return null;
  }

  const observation = parseProviderModeObservation({
    mode: value.mode,
    paymentProcessorKind: value.paymentProcessorKind,
    moneyMovementKind: value.moneyMovementKind,
    deploymentEnvironment: value.deploymentEnvironment,
  });
  if (!observation) {
    return null;
  }

  return { ...observation, observedAt };
}
