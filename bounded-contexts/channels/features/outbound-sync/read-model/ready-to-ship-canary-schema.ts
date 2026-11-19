export const readyToShipCanarySchema = [
  `CREATE TABLE IF NOT EXISTS channel_ready_to_ship_canaries (
    page_claim text PRIMARY KEY,
    seal_digest text NOT NULL UNIQUE,
    connection_id text NOT NULL,
    pairing_id text NOT NULL,
    grant_id text NOT NULL,
    state text NOT NULL CHECK (state IN ('armed','claimed','posted','failed','expired')),
    expires_at timestamptz NOT NULL,
    handoff jsonb NULL,
    reservation_id text UNIQUE,
    operation_id text NULL,
    attempt_id text NULL,
    pull_id text NULL,
    payload_digest text NULL,
    members text[] NOT NULL,
    admitted text[] NOT NULL DEFAULT '{}',
    CHECK ((state = 'armed') = (handoff IS NOT NULL))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_ready_to_ship_canaries_live_idx
     ON channel_ready_to_ship_canaries (connection_id) WHERE state IN ('armed','claimed')`,
  `CREATE INDEX IF NOT EXISTS channel_ready_to_ship_canaries_expiry_idx
     ON channel_ready_to_ship_canaries (expires_at, page_claim) WHERE state IN ('armed','claimed')`,
] as const;
