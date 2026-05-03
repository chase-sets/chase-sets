import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { paymentsOrderInputSchemaSql } from "../../features/payments/integrations/order-input/order-input-schema";
import { paymentsPaymentSchemaSql } from "../../features/payments/read-model/schema";
import { paymentsRefundSchemaSql } from "../../features/refunds/read-model/schema";

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
  paymentsOrderInputSchemaSql,
  paymentsPaymentSchemaSql,
  paymentsRefundSchemaSql,
  paymentsWorkClaimSchemaSql,
].join("\n\n");
