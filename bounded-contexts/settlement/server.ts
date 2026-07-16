export { createSettlementRequestApiClient } from "./support/request-support/api-client";
export type { SettlementPayoutReadinessRow } from "./support/request-support/api-client";
/**
 * The wallet route builder, exposed for composition-root and runtime
 * authorization tests that mount the real operator wallet-mutation routes
 * behind the platform actor middleware rather than a unit-constructed app.
 */
export { createWalletRoutes } from "./features/wallets/api/route";
export type { WalletServices } from "./features/wallets/api/runtime";
export { createSettlementBalanceCreditResolver } from "./features/wallets/api/balance-credit-resolver";
export type {
  SettlementBalanceCreditResolution,
  SettlementBalanceCreditResolver,
  WalletSpendHoldPort,
} from "./features/wallets/api/balance-credit-resolver";
export { createSettlementWalletSpendHoldPort } from "./features/wallets/api/balance-credit-hold-port";
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
/**
 * Support-safe Wallet Adjustment-by-reference lookups for the same unified
 * support-reference router (`WAD-...` / `wad_...`), assembled behind the same
 * `supportReferenceLookupCrossContext` host port as the payout lookups above.
 */
export {
  lookupWalletAdjustmentBySupportId,
  lookupWalletAdjustmentBySupportReference,
} from "./features/wallets/read-model/wallet-adjustment-support-lookup";
export type { SettlementWalletAdjustmentSupportLookupRow } from "./features/wallets/read-model/wallet-adjustment-support-lookup";
export { createBlockedPayoutAttentionSourceFromReadModel } from "./features/payouts/read-model/seller-attention-source";
export {
  getProtectionReserveSummary,
  type ProtectionReserveSummary,
} from "./features/wallets/read-model/protection-reserve-summary";
