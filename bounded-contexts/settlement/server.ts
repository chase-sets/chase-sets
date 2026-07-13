export { createSettlementRequestApiClient } from "./support/request-support/api-client";
export type { SettlementPayoutReadinessRow } from "./support/request-support/api-client";
export { createSettlementBalanceCreditResolver } from "./features/wallets/api/balance-credit-resolver";
export type {
  SettlementBalanceCreditResolution,
  SettlementBalanceCreditResolver,
} from "./features/wallets/api/balance-credit-resolver";
export type {
  MoneyMovementGateway,
  MoneyMovementWebhookEvent,
  ProviderPayoutReadiness,
} from "@chase-sets/money-movement";
export { settlementOperationLogFields } from "./support/runtime-support/operations";
export type { SettlementServices } from "./support/runtime-support/services";
/**
 * Policy definitions for the platform policy console: Platform
 * Operations imports these (via `policyConsoleCrossContext`, assembled in
 * the `platform-api` composition root) to list, show history for, and
 * revise these policies through the shared machinery -- without ever
 * importing Settlement's domain code directly.
 */
export { settlementClearancePolicy } from "./features/wallets/domain/clearance-policy";
export type { SettlementClearancePolicyValue } from "./features/wallets/domain/clearance-policy";
export { settlementPayoutBoundsPolicy } from "./features/payouts/domain/payout-policy";
export type { SettlementPayoutBoundsPolicyValue } from "./features/payouts/domain/payout-policy";
/**
 * Support-safe payout-by-reference lookups for the unified
 * support-reference router, assembled in the `platform-api` composition
 * root behind Platform Operations' `supportReferenceLookupCrossContext`
 * host port -- Platform Operations never imports Settlement's domain code directly.
 */
export { lookupPayoutBySupportId, lookupPayoutBySupportReference } from "./features/payouts/read-model/support-lookup";
export type { SettlementSupportLookupRow } from "./features/payouts/read-model/support-lookup";
export {
  getProtectionReserveSummary,
  type ProtectionReserveSummary,
} from "./features/wallets/read-model/protection-reserve-summary";
