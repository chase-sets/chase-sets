import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { settlementWalletSchemaMigrations, settlementWalletSchemaSql } from "../../features/wallets/read-model/schema";
import {
  settlementWalletAdjustmentSchemaMigrations,
  settlementWalletAdjustmentSchemaSql,
} from "../../features/wallets/read-model/wallet-adjustment-schema";
import { settlementPaymentSourceSchemaSql } from "../../features/wallets/integrations/payment-source/payment-source-schema";
import { settlementSupportSourceSchemaSql } from "../../features/wallets/integrations/support-source/support-source-schema";
import { settlementFulfillmentSourceSchemaSql } from "../../features/wallets/integrations/fulfillment-source/fulfillment-source-schema";
import {
  settlementAccountRiskSourceSchemaMigrations,
  settlementAccountRiskSourceSchemaSql,
} from "../../features/wallets/integrations/account-risk-source/account-risk-source-schema";
import { settlementPayoutSchemaMigrations, settlementPayoutSchemaSql } from "../../features/payouts/read-model/schema";
import {
  settlementProtectionCoverageSchemaMigrations,
  settlementProtectionCoverageSchemaSql,
} from "../../features/protection-coverage/read-model/protection-coverage-schema";
import { settlementRefundLiabilityAllocationSchemaSql } from "../../features/liability-allocation/read-model/liability-allocation-schema";
import { settlementLiabilityReconciliationSchemaSql } from "../../features/liability-reconciliation/read-model/liability-reconciliation";
import {
  settlementPayoutReadinessSchemaMigrations,
  settlementPayoutReadinessSchemaSql,
} from "../../features/payout-readiness/read-model/schema";

export const settlementWorkClaimSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_work_claims (
  work_kind text NOT NULL,
  entity_id text NOT NULL,
  owner_id text NOT NULL,
  claim_expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  next_eligible_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (work_kind, entity_id)
);

CREATE INDEX IF NOT EXISTS settlement_work_claims_owner_idx
  ON settlement_work_claims (owner_id);

CREATE INDEX IF NOT EXISTS settlement_work_claims_eligible_idx
  ON settlement_work_claims (work_kind, claim_expires_at, next_eligible_at);
`;

export const settlementSchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  settlementPaymentSourceSchemaSql,
  settlementSupportSourceSchemaSql,
  settlementFulfillmentSourceSchemaSql,
  settlementAccountRiskSourceSchemaSql,
  settlementWalletSchemaSql,
  settlementWalletAdjustmentSchemaSql,
  settlementPayoutReadinessSchemaSql,
  settlementPayoutSchemaSql,
  settlementProtectionCoverageSchemaSql,
  settlementRefundLiabilityAllocationSchemaSql,
  settlementLiabilityReconciliationSchemaSql,
  settlementWorkClaimSchemaSql,
  // Adopts the shared platform-policy machinery (see infrastructure/platform-policy)
  // for the clearance-window and payout-bounds policies -- see
  // ../../features/wallets/domain/clearance-policy.ts and
  // ../../features/payouts/domain/payout-policy.ts.
  platformPolicySchemaSql,
].join("\n\n");

export const settlementSchemaMigrations = [
  ...settlementWalletSchemaMigrations,
  ...settlementWalletAdjustmentSchemaMigrations,
  ...settlementAccountRiskSourceSchemaMigrations,
  ...settlementPayoutReadinessSchemaMigrations,
  ...settlementPayoutSchemaMigrations,
  ...settlementProtectionCoverageSchemaMigrations,
] as const;
