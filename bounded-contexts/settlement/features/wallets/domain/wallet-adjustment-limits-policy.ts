import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  addMoney,
  compareMoney,
  normalizeMoneyAmount,
  SettlementDomainError,
} from "../../../support/runtime-support/common";

/**
 * The `settlement.wallet-adjustment-limits` platform policy: the operational
 * volume ceilings and kill switch that sit alongside ADR 0020's approval
 * matrix (`wallet-adjustment-controls-policy.ts`). Where the controls policy
 * governs WHO must approve a Wallet Adjustment, this policy governs HOW MUCH
 * money-movement volume is allowed to flow through the lifecycle in a given
 * time window, and whether the entire write surface is halted.
 *
 * Kept as a separate policy document from `settlement.wallet-adjustment-controls`
 * deliberately: the ADR 0020 schema is ratified vocabulary reopened only by an
 * ADR revision, while these operational limits are expected to be tuned by
 * Money Operations during incident response far more often. Same
 * `definePolicy`/`PolicyRuntime` machinery as `walletAdjustmentControlsPolicy`
 * and `rateLimitPolicy` -- an operator can revise every value here without a
 * deploy, with the usual policy audit history, and every resolution falls
 * back to the conservative compiled default below until an operator revises
 * it.
 *
 * `haltNewActions` is the money-operations kill switch: when `true`, the API
 * boundary blocks new Wallet Adjustment request/approve/reverse actions
 * (`wallet-adjustment-route.ts`) while reads, the reconciliation report, and
 * resuming an already-approved posting stay available. It defaults to `false`
 * (normal operation) -- the safe-state guarantee is that policy or
 * actor-fact resolution FAILURES are treated as halted (fail closed), not
 * that the compiled default itself starts halted.
 */
export type WalletAdjustmentLimitsPolicyValue = Readonly<{
  haltNewActions: boolean;
  perAdjustmentMaxAmount: string;
  perAccountWindowMaxAmount: string;
  perAccountWindowMaxCount: number;
  perOperatorWindowMaxAmount: string;
  perOperatorWindowMaxCount: number;
  windowHours: number;
}>;

/**
 * Conservative compiled defaults. `perAdjustmentMaxAmount` matches the prior
 * hardcoded `MAX_ADJUSTMENT_AMOUNT` ceiling in `wallet-adjustment-route.ts` so
 * making it policy-governed is not itself a behavior change. The window caps
 * are new: sized to require an explicit elevated approval matrix decision
 * (ADR 0020's $500.00 high-value threshold) well before a single account or
 * operator could accumulate a full day of ordinary-severity adjustments.
 */
export const WALLET_ADJUSTMENT_LIMITS_DEFAULT: WalletAdjustmentLimitsPolicyValue = {
  haltNewActions: false,
  perAdjustmentMaxAmount: "1000000.00",
  perAccountWindowMaxAmount: "2000.00",
  perAccountWindowMaxCount: 5,
  perOperatorWindowMaxAmount: "10000.00",
  perOperatorWindowMaxCount: 20,
  windowHours: 24,
};

const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 24 * 30;
const MIN_WINDOW_COUNT = 1;
const MAX_WINDOW_COUNT = 100_000;

export function normalizeWalletAdjustmentLimits(
  value: WalletAdjustmentLimitsPolicyValue,
): WalletAdjustmentLimitsPolicyValue {
  if (typeof value.haltNewActions !== "boolean") {
    throw new SettlementDomainError("Wallet Adjustment limits 'haltNewActions' must be a boolean.");
  }
  if (
    !Number.isInteger(value.windowHours) ||
    value.windowHours < MIN_WINDOW_HOURS ||
    value.windowHours > MAX_WINDOW_HOURS
  ) {
    throw new SettlementDomainError(
      `Wallet Adjustment limits 'windowHours' must be a whole number between ${MIN_WINDOW_HOURS} and ${MAX_WINDOW_HOURS}.`,
    );
  }
  for (const [field, count] of [
    ["perAccountWindowMaxCount", value.perAccountWindowMaxCount],
    ["perOperatorWindowMaxCount", value.perOperatorWindowMaxCount],
  ] as const) {
    if (!Number.isInteger(count) || count < MIN_WINDOW_COUNT || count > MAX_WINDOW_COUNT) {
      throw new SettlementDomainError(
        `Wallet Adjustment limits '${field}' must be a whole number between ${MIN_WINDOW_COUNT} and ${MAX_WINDOW_COUNT}.`,
      );
    }
  }
  return {
    haltNewActions: value.haltNewActions,
    perAdjustmentMaxAmount: normalizeMoneyAmount(value.perAdjustmentMaxAmount, {
      fieldName: "Wallet Adjustment per-adjustment maximum amount",
    }),
    perAccountWindowMaxAmount: normalizeMoneyAmount(value.perAccountWindowMaxAmount, {
      fieldName: "Wallet Adjustment per-account window maximum amount",
    }),
    perAccountWindowMaxCount: value.perAccountWindowMaxCount,
    perOperatorWindowMaxAmount: normalizeMoneyAmount(value.perOperatorWindowMaxAmount, {
      fieldName: "Wallet Adjustment per-operator window maximum amount",
    }),
    perOperatorWindowMaxCount: value.perOperatorWindowMaxCount,
    windowHours: value.windowHours,
  };
}

export function decodeWalletAdjustmentLimitsPolicyValue(raw: JsonValue): WalletAdjustmentLimitsPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Wallet Adjustment limits policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;
  return normalizeWalletAdjustmentLimits({
    haltNewActions: (record.haltNewActions ?? false) as boolean,
    perAdjustmentMaxAmount: String(record.perAdjustmentMaxAmount ?? ""),
    perAccountWindowMaxAmount: String(record.perAccountWindowMaxAmount ?? ""),
    perAccountWindowMaxCount: Number(record.perAccountWindowMaxCount),
    perOperatorWindowMaxAmount: String(record.perOperatorWindowMaxAmount ?? ""),
    perOperatorWindowMaxCount: Number(record.perOperatorWindowMaxCount),
    windowHours: Number(record.windowHours),
  });
}

export const walletAdjustmentLimitsPolicy: PolicyDefinition<WalletAdjustmentLimitsPolicyValue> = definePolicy({
  policyKey: "settlement.wallet-adjustment-limits",
  contextName: "settlement",
  schemaSummary:
    "{ haltNewActions: boolean, perAdjustmentMaxAmount: decimal string >= 0, perAccountWindowMaxAmount: decimal string >= 0, perAccountWindowMaxCount: integer 1-100000, perOperatorWindowMaxAmount: decimal string >= 0, perOperatorWindowMaxCount: integer 1-100000, windowHours: integer 1-720 }",
  defaultValue: WALLET_ADJUSTMENT_LIMITS_DEFAULT,
  decodeValue: decodeWalletAdjustmentLimitsPolicyValue,
});

/** A bounded window of a target account's or operator's recent Wallet Adjustment activity. */
export type WalletAdjustmentActivityWindow = Readonly<{
  /** Sum of amounts across `posted`/`reversed` adjustments in the window -- actual money movement only. */
  postedAmount: string;
  /** Count of adjustments requested in the window, regardless of terminal status -- bounds request churn. */
  requestedCount: number;
}>;

export type WalletAdjustmentLimitViolationCode =
  | "per-adjustment-max-amount"
  | "per-account-window-max-amount"
  | "per-account-window-max-count"
  | "per-operator-window-max-amount"
  | "per-operator-window-max-count";

export type WalletAdjustmentLimitViolation = Readonly<{
  code: WalletAdjustmentLimitViolationCode;
  message: string;
}>;

/**
 * Pure evaluation of a proposed Wallet Adjustment amount against the resolved
 * limits policy and the target account's/operator's already-observed
 * activity in the current window. Called from `request()` before the
 * lifecycle command is issued, so a limit violation never creates a
 * `requested` stream -- the operator sees the rejection immediately rather
 * than a request that can never be approved.
 */
export function evaluateWalletAdjustmentLimits(
  limits: WalletAdjustmentLimitsPolicyValue,
  input: Readonly<{
    amount: string;
    targetAccountActivity: WalletAdjustmentActivityWindow;
    operatorActivity: WalletAdjustmentActivityWindow;
  }>,
): readonly WalletAdjustmentLimitViolation[] {
  const violations: WalletAdjustmentLimitViolation[] = [];

  if (compareMoney(input.amount, limits.perAdjustmentMaxAmount) > 0) {
    violations.push({
      code: "per-adjustment-max-amount",
      message: `Amount exceeds the per-adjustment maximum of ${limits.perAdjustmentMaxAmount}.`,
    });
  }

  const projectedAccountAmount = addMoney(input.targetAccountActivity.postedAmount, input.amount);
  if (compareMoney(projectedAccountAmount, limits.perAccountWindowMaxAmount) > 0) {
    violations.push({
      code: "per-account-window-max-amount",
      message: `Target account would exceed the ${limits.windowHours}-hour window maximum of ${limits.perAccountWindowMaxAmount}.`,
    });
  }
  if (input.targetAccountActivity.requestedCount + 1 > limits.perAccountWindowMaxCount) {
    violations.push({
      code: "per-account-window-max-count",
      message: `Target account would exceed the ${limits.windowHours}-hour window request count maximum of ${limits.perAccountWindowMaxCount}.`,
    });
  }

  const projectedOperatorAmount = addMoney(input.operatorActivity.postedAmount, input.amount);
  if (compareMoney(projectedOperatorAmount, limits.perOperatorWindowMaxAmount) > 0) {
    violations.push({
      code: "per-operator-window-max-amount",
      message: `Requesting operator would exceed the ${limits.windowHours}-hour window maximum of ${limits.perOperatorWindowMaxAmount}.`,
    });
  }
  if (input.operatorActivity.requestedCount + 1 > limits.perOperatorWindowMaxCount) {
    violations.push({
      code: "per-operator-window-max-count",
      message: `Requesting operator would exceed the ${limits.windowHours}-hour window request count maximum of ${limits.perOperatorWindowMaxCount}.`,
    });
  }

  return violations;
}
