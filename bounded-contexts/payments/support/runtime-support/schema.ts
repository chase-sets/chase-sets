import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import {
  paymentsOrderInputSchemaMigrations,
  paymentsOrderInputSchemaSql,
} from "../../features/payments/integrations/order-input/order-input-schema";
import {
  paymentsDisputeEvidenceSourceSchemaMigrations,
  paymentsDisputeEvidenceSourceSchemaSql,
} from "../../features/payments/integrations/dispute-evidence/dispute-evidence-schema";
import { paymentsPaymentSchemaMigrations, paymentsPaymentSchemaSql } from "../../features/payments/read-model/schema";
import { paymentsOrderCancellationRefundEffectSchemaSql } from "../../features/refunds/integrations/ordering/order-cancellation-refund-effect-schema";
import { paymentsSupportRefundEffectSchemaSql } from "../../features/refunds/integrations/support/support-refund-effect-schema";
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
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  paymentsOrderInputSchemaSql,
  paymentsDisputeEvidenceSourceSchemaSql,
  paymentsOrderCancellationRefundEffectSchemaSql,
  paymentsSupportRefundEffectSchemaSql,
  paymentsPaymentSchemaSql,
  paymentsRefundSchemaSql,
  paymentsWorkClaimSchemaSql,
].join("\n\n");

export const paymentsSchemaMigrations = [
  ...paymentsOrderInputSchemaMigrations,
  ...paymentsDisputeEvidenceSourceSchemaMigrations,
  ...paymentsPaymentSchemaMigrations,
  ...paymentsRefundSchemaMigrations,
] as const;
