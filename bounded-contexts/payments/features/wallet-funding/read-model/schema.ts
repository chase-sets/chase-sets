import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const walletFundingSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_wallet_funding_pages (
  funding_id text PRIMARY KEY,
  account_id text NOT NULL,
  processor_payment_reference text,
  status text NOT NULL,
  state jsonb NOT NULL,
  last_stream_version bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments_wallet_funding_creation_reservations (
  funding_id text PRIMARY KEY,
  account_id text NOT NULL,
  requested_amount numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL,
  reconciled_at timestamptz,
  released boolean NOT NULL DEFAULT false
);`;

export const walletFundingSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260927_payments_wallet_funding_terminal_refusal_attention",
    description:
      "Normalize historical refused intents and initialize durable refund attention without changing economics or reservations.",
    statements: [
      walletFundingSchemaSql,
      `UPDATE payments_wallet_funding_pages p SET state =
        jsonb_set(jsonb_set(p.state, '{refundAttention}', COALESCE(p.state->'refundAttention', '[]'::jsonb)),
          '{refunds}', COALESCE((SELECT jsonb_object_agg(r.key,
            CASE WHEN r.value->>'status' = 'intent' AND r.value->>'exception' = 'authority-refused'
              THEN jsonb_set(r.value, '{status}', '"refused"'::jsonb) ELSE r.value END)
            FROM jsonb_each(p.state->'refunds') r), '{}'::jsonb))
        WHERE NOT p.state ? 'refundAttention' OR EXISTS
          (SELECT 1 FROM jsonb_each(p.state->'refunds') r
           WHERE r.value->>'status' = 'intent' AND r.value->>'exception' = 'authority-refused')`,
    ],
  },
  {
    migrationId: "20260927_payments_wallet_funding_indexes",
    description: "Index wallet funding account history, provider lookup and creation limits.",
    statements: [
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_wallet_funding_account_idx ON payments_wallet_funding_pages (account_id, funding_id)",
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS payments_wallet_funding_processor_idx ON payments_wallet_funding_pages (processor_payment_reference) WHERE processor_payment_reference IS NOT NULL",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_wallet_funding_creation_account_idx ON payments_wallet_funding_creation_reservations (account_id, created_at) WHERE NOT released",
    ],
  },
];
