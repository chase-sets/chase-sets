import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { walletFundingSchemaSql, walletFundingSchemaMigrations } from "../../features/wallet-funding/read-model/schema";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import {
  paymentsCardDeclineSchemaSql,
  paymentsCardDeclineSchemaMigrations,
} from "../../features/payments/api/card-decline-schema";
import {
  paymentsOrderInputSchemaMigrations,
  paymentsOrderInputSchemaSql,
} from "../../features/payments/integrations/order-input/order-input-schema";
import {
  paymentsDisputeEvidenceSourceSchemaMigrations,
  paymentsDisputeEvidenceSourceSchemaSql,
} from "../../features/payments/integrations/dispute-evidence/dispute-evidence-schema";
import {
  paymentsAccountRiskSourceExpansionSchemaSql,
  paymentsPaymentCreationReservationExpansionSchemaSql,
  paymentsPaymentSchemaMigrations,
  paymentsPaymentSchemaSql,
} from "../../features/payments/read-model/schema";
import {
  paymentsOrderCancellationRefundEffectSchemaMigrations,
  paymentsOrderCancellationRefundEffectSchemaSql,
} from "../../features/refunds/integrations/ordering/order-cancellation-refund-effect-schema";
import {
  paymentsSupportRefundEffectSchemaMigrations,
  paymentsSupportRefundEffectSchemaSql,
} from "../../features/refunds/integrations/support/support-refund-effect-schema";
import { paymentsRefundSchemaMigrations, paymentsRefundSchemaSql } from "../../features/refunds/read-model/schema";

export const paymentsWorkClaimSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_work_claims (
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

CREATE INDEX IF NOT EXISTS payments_work_claims_owner_idx
  ON payments_work_claims (owner_id);

CREATE INDEX IF NOT EXISTS payments_work_claims_eligible_idx
  ON payments_work_claims (work_kind, claim_expires_at, next_eligible_at);
`;

export const paymentsSchemaSql = [
  walletFundingSchemaSql,
  platformPolicySchemaSql,
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  paymentsOrderInputSchemaSql,
  paymentsDisputeEvidenceSourceSchemaSql,
  paymentsOrderCancellationRefundEffectSchemaSql,
  paymentsSupportRefundEffectSchemaSql,
  paymentsPaymentSchemaSql,
  paymentsPaymentCreationReservationExpansionSchemaSql,
  paymentsAccountRiskSourceExpansionSchemaSql,
  paymentsRefundSchemaSql,
  paymentsWorkClaimSchemaSql,
  paymentsCardDeclineSchemaSql,
].join("\n\n");

export const paymentsSchemaMigrations = [
  ...paymentsCardDeclineSchemaMigrations,
  ...walletFundingSchemaMigrations,
  ...paymentsOrderInputSchemaMigrations,
  ...paymentsDisputeEvidenceSourceSchemaMigrations,
  ...paymentsPaymentSchemaMigrations,
  ...paymentsRefundSchemaMigrations,
  ...paymentsOrderCancellationRefundEffectSchemaMigrations,
  ...paymentsSupportRefundEffectSchemaMigrations,
  {
    migrationId: "20261123_payments_policy_documents_logged",
    description:
      "Keep policy documents through a crash: an emptied table resolves every policy to its compiled default until a replay ends.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE platform_policy_documents SET LOGGED;",
      "ALTER TABLE platform_policy_document_history SET LOGGED;",
    ],
  },
] as const;
