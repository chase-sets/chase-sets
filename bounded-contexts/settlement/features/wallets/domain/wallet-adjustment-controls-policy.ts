import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { SettlementDomainError } from "../../../support/runtime-support/common";
import {
  normalizeWalletAdjustmentControls,
  WALLET_ADJUSTMENT_CONTROLS_DEFAULT,
  type WalletAdjustmentControls,
} from "./wallet-adjustment";

/**
 * The `settlement.wallet-adjustment-controls` platform policy ratified by
 * ADR 0020: the two high-value dollar thresholds and the recent-authentication
 * ("step-up") window that govern a Wallet Adjustment's approval matrix. This
 * is the same `definePolicy`/`PolicyRuntime` machinery as
 * `settlementClearancePolicy` -- an operator can revise the thresholds and
 * the recent-auth window without a deploy, with the usual policy audit
 * history, and every resolution falls back to the ADR's conservative
 * compiled default (`500.00` / `500.00` / 15 minutes) until an operator
 * revises it.
 *
 * Negative-balance elevation, reversal-after-spend elevation, and the
 * self-benefiting block are unconditional per the ADR's approval matrix, so
 * they are policy-independent booleans enforced by the `WalletAdjustment`
 * domain decider -- not part of this numeric schema.
 */
export function decodeWalletAdjustmentControlsPolicyValue(raw: JsonValue): WalletAdjustmentControls {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Wallet Adjustment controls policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;
  return normalizeWalletAdjustmentControls({
    highValueCreditThresholdAmount: String(record.highValueCreditThresholdAmount ?? ""),
    highValueDebitThresholdAmount: String(record.highValueDebitThresholdAmount ?? ""),
    recentAuthMaxAgeMinutes: Number(record.recentAuthMaxAgeMinutes),
  });
}

export const walletAdjustmentControlsPolicy: PolicyDefinition<WalletAdjustmentControls> = definePolicy({
  policyKey: "settlement.wallet-adjustment-controls",
  contextName: "settlement",
  schemaSummary:
    "{ highValueCreditThresholdAmount: decimal string >= 0, highValueDebitThresholdAmount: decimal string >= 0, recentAuthMaxAgeMinutes: integer > 0 }",
  defaultValue: WALLET_ADJUSTMENT_CONTROLS_DEFAULT,
  decodeValue: decodeWalletAdjustmentControlsPolicyValue,
});
