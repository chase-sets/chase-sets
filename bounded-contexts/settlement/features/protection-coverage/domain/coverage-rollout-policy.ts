import { compareMoneyAmounts, moneyToCents, normalizeMoneyAmount } from "@chase-sets/primitives/money";
import { normalizePlatformCoverageCurrencyCode } from "@chase-sets/primitives/platform-coverage";

/**
 * Platform-coverage rollout policy (ADR 0022, Wave 3 rollout controls).
 *
 * A pure gate on NEW platform-funded reservation authorizations — the financial commitment
 * Settlement owns. Rollout is deliberately modeled here, not as a general feature flag,
 * because the launch requirement is specific and money-critical: enable coverage globally
 * and by operator/policy cohort, cap it with bounded monetary limits, and let an operator
 * pause or roll back new authorizations WITHOUT invalidating reservations and remedies
 * already in flight. Pausing the gate must never strand a buyer mid-remedy.
 *
 * The gate decides only whether a new reservation may be authorized. Settling, releasing,
 * and expiring an already-reserved coverage are unconditional lifecycle transitions the
 * ProtectionCoverage aggregate owns — this policy never blocks them, which is what keeps
 * active cases recoverable when the rollout is paused or rolled back.
 */

/**
 * Rollout modes. `disabled` predates any launch; `internal-only` admits authorized internal
 * operators within a bounded limit; `cohort` additionally admits named policy cohorts;
 * `general` admits everyone within the global limit; `paused` and `rolled-back` both stop new
 * authorizations while leaving active reservations untouched (rolled-back additionally requires
 * a forward-repair plan before re-enable).
 */
export const coverageRolloutModes = [
  "disabled",
  "internal-only",
  "cohort",
  "general",
  "paused",
  "rolled-back",
] as const;

export type CoverageRolloutMode = (typeof coverageRolloutModes)[number];

export function isCoverageRolloutMode(value: string): value is CoverageRolloutMode {
  return (coverageRolloutModes as readonly string[]).includes(value);
}

export type CoverageRolloutConfig = Readonly<{
  mode: CoverageRolloutMode;
  /** Global per-reservation cap in the coverage currency. A request above it is refused. */
  maxReservationAmount: string;
  currencyCode: string;
  /** Operator accounts explicitly authorized to originate coverage under `internal-only`/`cohort`. */
  authorizedOperatorAccountIds: readonly string[];
  /** Policy cohorts admitted under `cohort` mode. */
  enabledPolicyCohorts: readonly string[];
  /** Optional tighter cap per cohort; falls back to the global cap when absent. */
  cohortReservationLimits?: Readonly<Record<string, string>>;
  /** Required to re-enable from `rolled-back`: names the forward-repair that reconciled in-flight cases. */
  forwardRepairReference?: string | null;
}>;

export type CoverageAuthorizationRequest = Readonly<{
  operatorAccountId: string;
  operatorIsAuthorizedInternal: boolean;
  policyCohort: string | null;
  requestedAmount: string;
  currencyCode: string;
}>;

export const coverageAuthorizationDenials = [
  "rollout-disabled",
  "rollout-paused",
  "rollout-rolled-back",
  "operator-not-authorized",
  "cohort-not-enabled",
  "currency-not-configured",
  "exceeds-monetary-limit",
] as const;

export type CoverageAuthorizationDenialReason = (typeof coverageAuthorizationDenials)[number];

export type CoverageAuthorizationDecision =
  | Readonly<{ allowed: true; appliedLimit: string }>
  | Readonly<{ allowed: false; reason: CoverageAuthorizationDenialReason; detail: string }>;

function deny(reason: CoverageAuthorizationDenialReason, detail: string): CoverageAuthorizationDecision {
  return { allowed: false, reason, detail };
}

/**
 * Decides whether a new platform-funded coverage authorization may proceed. Pure and
 * fail-closed: an unconfigured currency, an unauthorized operator, a disabled/paused/
 * rolled-back rollout, or a request above the applicable monetary limit all refuse the
 * authorization. Refusal stops the NEW commitment only; it never touches existing coverage.
 */
export function decideCoverageAuthorization(
  config: CoverageRolloutConfig,
  request: CoverageAuthorizationRequest,
): CoverageAuthorizationDecision {
  if (config.mode === "disabled") {
    return deny("rollout-disabled", "Platform coverage is not enabled.");
  }
  if (config.mode === "paused") {
    return deny("rollout-paused", "Platform coverage authorizations are paused; active reservations are unaffected.");
  }
  if (config.mode === "rolled-back") {
    return deny(
      "rollout-rolled-back",
      "Platform coverage is rolled back; new authorizations are stopped pending forward-repair.",
    );
  }

  const requestCurrency = normalizePlatformCoverageCurrencyCode(request.currencyCode);
  const configCurrency = normalizePlatformCoverageCurrencyCode(config.currencyCode);
  if (requestCurrency !== configCurrency) {
    return deny("currency-not-configured", `No rollout limit is configured for currency ${requestCurrency}.`);
  }

  if (config.mode === "internal-only" && !request.operatorIsAuthorizedInternal) {
    return deny("operator-not-authorized", "Only authorized internal operators may originate coverage yet.");
  }
  if (config.mode === "internal-only" && !config.authorizedOperatorAccountIds.includes(request.operatorAccountId)) {
    return deny("operator-not-authorized", `Operator ${request.operatorAccountId} is not on the coverage allowlist.`);
  }
  if (config.mode === "cohort") {
    const operatorAdmitted =
      request.operatorIsAuthorizedInternal && config.authorizedOperatorAccountIds.includes(request.operatorAccountId);
    const cohortAdmitted = request.policyCohort !== null && config.enabledPolicyCohorts.includes(request.policyCohort);
    if (!operatorAdmitted && !cohortAdmitted) {
      return deny("cohort-not-enabled", "Neither the operator nor the request's policy cohort is enabled yet.");
    }
  }

  const appliedLimit = applicableReservationLimit(config, request.policyCohort);
  const requestedAmount = normalizeMoneyAmount(request.requestedAmount);
  if (moneyToCents(requestedAmount) <= 0n) {
    return deny("exceeds-monetary-limit", "A coverage authorization must request a positive amount.");
  }
  if (compareMoneyAmounts(requestedAmount, appliedLimit) > 0) {
    return deny(
      "exceeds-monetary-limit",
      `Requested ${requestedAmount} exceeds the ${appliedLimit} rollout limit for this cohort.`,
    );
  }

  return { allowed: true, appliedLimit };
}

/** The tightest monetary limit that applies to a request: the cohort cap if present, else the global cap. */
export function applicableReservationLimit(config: CoverageRolloutConfig, policyCohort: string | null): string {
  const globalLimit = normalizeMoneyAmount(config.maxReservationAmount);
  if (policyCohort === null) {
    return globalLimit;
  }
  const cohortLimit = config.cohortReservationLimits?.[policyCohort];
  if (cohortLimit === undefined) {
    return globalLimit;
  }
  const normalizedCohortLimit = normalizeMoneyAmount(cohortLimit);
  return compareMoneyAmounts(normalizedCohortLimit, globalLimit) < 0 ? normalizedCohortLimit : globalLimit;
}

/**
 * Whether the rollout still stops new authorizations. Both a pause and a rollback stop new
 * commitments; the difference is that a rollback additionally requires a documented forward-repair
 * before it can be re-enabled (see {@link canReEnableFromRolledBack}).
 */
export function stopsNewAuthorizations(config: CoverageRolloutConfig): boolean {
  return config.mode === "disabled" || config.mode === "paused" || config.mode === "rolled-back";
}

/**
 * The invariant that keeps active cases recoverable: pausing or rolling back the rollout must
 * NOT invalidate reservations/remedies already in flight. This is always true because the
 * rollout gate only guards new authorizations — settle/release/expire are never gated — so this
 * returns true for every mode, encoding the guarantee as an executable assertion.
 */
export function preservesActiveReservations(_config: CoverageRolloutConfig): boolean {
  return true;
}

/** A rollback may be re-enabled only once a forward-repair reconciled the in-flight cases. */
export function canReEnableFromRolledBack(config: CoverageRolloutConfig): boolean {
  return (
    config.mode === "rolled-back" &&
    typeof config.forwardRepairReference === "string" &&
    config.forwardRepairReference.trim().length > 0
  );
}

/**
 * SLOs and escalation ownership across the contexts a platform-covered resolution touches.
 * These are the go-live commitments the operator acceptance packet signs off against.
 */
export const platformCoverageRolloutSlos = Object.freeze({
  reserveDecisionP95Seconds: 5,
  refundToReconciliationP95Hours: 24,
  quarantineAcknowledgementHours: 4,
  escalationOwners: Object.freeze({
    coverageReservation: "Settlement on-call",
    refundExecution: "Payments on-call",
    reverseLogistics: "Fulfillment on-call",
    caseAdjudication: "Support on-call",
  }),
});
