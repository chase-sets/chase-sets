// Read model for parked attention-queue items. One row per parked item key; an
// active (unparked) item simply has no row, so the queue's default is "show
// everything". `deferred_until` drives the age-back-in behaviour: a deferred row
// stops suppressing its item once now passes the re-surface time.
export const catalogAttentionDismissalSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_attention_dismissals (
  item_key text PRIMARY KEY,
  kind text NOT NULL,
  disposition text NOT NULL,
  reason text NULL,
  deferred_until timestamptz NULL,
  actor text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_attention_dismissals_disposition_check
    CHECK (disposition IN ('dismissed', 'deferred'))
);

CREATE INDEX IF NOT EXISTS catalog_attention_dismissals_active_idx
  ON catalog_attention_dismissals (disposition, deferred_until);`;
