import type { AccountId, PayoutId } from "@chase-sets/primitives/typed-ids";
import type { CurrencyCode } from "./common";

export type SettlementProviderErrorCategory =
  | "provider_authentication"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_unavailable"
  | "provider_validation"
  | "missing_provider_account"
  | "unknown";

export type SettlementOperationEvent = Readonly<{
  kind:
    | "payout-requested"
    | "platform-balance-insufficient"
    | "provider-transfer-submitted"
    | "provider-payout-submitted"
    | "payout-completed"
    | "payout-failed"
    | "payout-reversal-posted"
    | "money-movement-webhook-ignored"
    | "payout-setup-session-created"
    | "payout-setup-session-failed"
    | "payout-account-management-session-created"
    | "payout-account-management-session-failed"
    | "payout-readiness-refresh-succeeded"
    | "payout-readiness-refresh-failed"
    | "payout-readiness-webhook-recorded"
    | "payout-readiness-webhook-ignored"
    | "payout-request-blocked-by-setup"
    | "payout-request-blocked-by-destination-friction"
    | "payout-destination-changed"
    | "provider-health-checked"
    | "wallet-adjustment-requested"
    | "wallet-adjustment-approved"
    | "wallet-adjustment-rejected"
    | "wallet-adjustment-posted"
    | "wallet-adjustment-reversed"
    | "wallet-adjustment-concurrency-conflict"
    | "wallet-adjustment-idempotent-retry"
    | "wallet-adjustment-negative-balance-effect"
    | "wallet-adjustment-halted"
    | "wallet-adjustment-limit-exceeded";
  accountId?: AccountId | string;
  payoutId?: PayoutId | string;
  amount?: string;
  currencyCode?: CurrencyCode | string;
  providerName?: string;
  providerEventId?: string;
  providerTransferReference?: string | null;
  providerPayoutReference?: string | null;
  providerReference?: string | null;
  setupSurface?:
    | "hosted-onboarding"
    | "hosted-account-management"
    | "embedded-payout-setup"
    | "embedded-account-management";
  readinessStatus?: string;
  onboardingStatus?: string;
  transferCapabilityStatus?: string;
  payoutCapabilityStatus?: string;
  payoutDestinationStatus?: string;
  payoutAccountDashboard?: string;
  missingRequirementCount?: number;
  advisoryRequirementCount?: number;
  disabledReason?: string | null;
  requirementsDeadline?: string | null;
  staleReadiness?: boolean;
  safeCategory?:
    | SettlementProviderErrorCategory
    | "setup_incomplete"
    | "setup_stale"
    | "requirements_open"
    | "step_up_required"
    // Bounded Wallet Adjustment categories: a reason code (closed 10-value
    // taxonomy), a limit-violation code (closed 5-value taxonomy), a gated
    // action name, or "unknown" -- never an id or free text.
    | (string & Record<never, never>);
  reason?: string | null;
  occurredAt: string;
}>;

export type SettlementOperationsRecorder = Readonly<{
  record: (event: SettlementOperationEvent) => void | Promise<void>;
}>;

export function createNoopSettlementOperationsRecorder(): SettlementOperationsRecorder {
  return {
    record: () => undefined,
  };
}

export function settlementOperationLogFields(event: Record<string, unknown>): Record<string, unknown> {
  const { reason: _reason, ...safeEvent } = event;
  return safeEvent;
}

export function classifySettlementProviderError(error: unknown): SettlementProviderErrorCategory {
  const code = readStringField(error, "code").toLowerCase();
  const type = readStringField(error, "type").toLowerCase();
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const statusCode = readNumberField(error, "statusCode") ?? readNumberField(error, "status");

  if (statusCode === 401 || statusCode === 403 || code.includes("auth") || type.includes("authentication")) {
    return "provider_authentication";
  }
  if (statusCode === 429 || code.includes("rate") || type.includes("rate")) {
    return "provider_rate_limited";
  }
  if (name.includes("abort") || code.includes("timeout") || type.includes("timeout")) {
    return "provider_timeout";
  }
  if (
    statusCode === 409 ||
    statusCode === 400 ||
    code.includes("invalid") ||
    code.includes("validation") ||
    type.includes("invalid")
  ) {
    return "provider_validation";
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return "provider_unavailable";
  }

  return "unknown";
}

function readStringField(value: unknown, field: string): string {
  if (!value || typeof value !== "object" || !(field in value)) {
    return "";
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" ? fieldValue : "";
}

function readNumberField(value: unknown, field: string): number | undefined {
  if (!value || typeof value !== "object" || !(field in value)) {
    return undefined;
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "number" && Number.isFinite(fieldValue) ? fieldValue : undefined;
}
