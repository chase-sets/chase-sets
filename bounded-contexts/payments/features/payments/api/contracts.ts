export type {
  PaymentsCheckoutStatus,
  PaymentsCheckoutRecoveryOptions,
  PaymentsAccountOrderInput,
  PaymentsMarketplaceCheckoutFeePolicy,
  PaymentsPaymentDetail,
} from "../ui/contracts";

const PAYMENT_PROVIDER_MODES = ["unconfigured", "test", "live"] as const;
const PAYMENT_PROVIDER_KINDS = ["fake", "stripe"] as const;
const DEPLOYMENT_ENVIRONMENTS = ["production", "staging", "preview", "test", "dev", "local", "remote-dev"] as const;

export type PaymentProviderModeObservation = Readonly<{
  mode: (typeof PAYMENT_PROVIDER_MODES)[number];
  paymentProcessorKind: (typeof PAYMENT_PROVIDER_KINDS)[number];
  moneyMovementKind: (typeof PAYMENT_PROVIDER_KINDS)[number];
  deploymentEnvironment: (typeof DEPLOYMENT_ENVIRONMENTS)[number];
}>;

export type PaymentProviderModeResponse = PaymentProviderModeObservation &
  Readonly<{
    observedAt: string;
  }>;

const OBSERVATION_KEYS = ["mode", "paymentProcessorKind", "moneyMovementKind", "deploymentEnvironment"] as const;
const RESPONSE_KEYS = [...OBSERVATION_KEYS, "observedAt"] as const;
const RFC_3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actualKeys = Reflect.ownKeys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => typeof key === "string" && keys.includes(key));
}

function isOneOf<const TValue extends string>(value: unknown, values: readonly TValue[]): value is TValue {
  return typeof value === "string" && values.includes(value as TValue);
}

function isRfc3339Instant(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = RFC_3339_INSTANT.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[9]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[10]);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;

  return (
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function hasConsistentProviderMode(
  observation: Pick<
    PaymentProviderModeObservation,
    "mode" | "paymentProcessorKind" | "moneyMovementKind" | "deploymentEnvironment"
  >,
): boolean {
  const hasStripeGateway = observation.paymentProcessorKind === "stripe" || observation.moneyMovementKind === "stripe";
  if (observation.mode === "unconfigured") {
    return !hasStripeGateway;
  }
  if (!hasStripeGateway) {
    return false;
  }
  return observation.mode === "live"
    ? observation.deploymentEnvironment === "production"
    : observation.deploymentEnvironment !== "production";
}

function isPaymentProviderModeObservation(value: unknown): value is PaymentProviderModeObservation {
  if (!isRecord(value) || !hasExactlyKeys(value, OBSERVATION_KEYS)) {
    return false;
  }
  if (
    !isOneOf(value.mode, PAYMENT_PROVIDER_MODES) ||
    !isOneOf(value.paymentProcessorKind, PAYMENT_PROVIDER_KINDS) ||
    !isOneOf(value.moneyMovementKind, PAYMENT_PROVIDER_KINDS) ||
    !isOneOf(value.deploymentEnvironment, DEPLOYMENT_ENVIRONMENTS)
  ) {
    return false;
  }
  return hasConsistentProviderMode(value as PaymentProviderModeObservation);
}

export function isPaymentProviderModeResponse(value: unknown): value is PaymentProviderModeResponse {
  if (!isRecord(value) || !hasExactlyKeys(value, RESPONSE_KEYS) || !isRfc3339Instant(value.observedAt)) {
    return false;
  }
  return isPaymentProviderModeObservation({
    mode: value.mode,
    paymentProcessorKind: value.paymentProcessorKind,
    moneyMovementKind: value.moneyMovementKind,
    deploymentEnvironment: value.deploymentEnvironment,
  });
}

export function createPaymentProviderModeResponse(
  observation: unknown,
  observedAt: string,
): PaymentProviderModeResponse | null {
  if (!isPaymentProviderModeObservation(observation)) {
    return null;
  }

  const response = { ...observation, observedAt };
  return isPaymentProviderModeResponse(response) ? response : null;
}
