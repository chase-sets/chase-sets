import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const catalogOperatorSessionOutcomeSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_tcgplayer_operator_session_outcomes (
  provider_key text PRIMARY KEY CHECK (provider_key = 'tcgplayer'),
  source text NOT NULL CHECK (source IN ('operator-session', 'environment')),
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  custody_revision bigint NOT NULL CHECK (custody_revision BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('untested', 'healthy', 'rejecting')),
  state_since timestamptz NOT NULL CHECK (isfinite(state_since)),
  last_rejection_at timestamptz NULL CHECK (isfinite(last_rejection_at)),
  last_rejection_status integer NULL CHECK (last_rejection_status IN (401, 403)),
  rate_budget_context text NOT NULL CHECK (rate_budget_context IN ('retained', 'unknown')),
  ever_succeeded boolean NOT NULL,
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
  CHECK ((source = 'environment' AND revision = 0) OR
    (source = 'operator-session' AND revision = custody_revision AND revision > 0)),
  CHECK ((state = 'rejecting' AND last_rejection_at IS NOT NULL AND last_rejection_status IS NOT NULL) OR
    (state <> 'rejecting' AND last_rejection_at IS NULL AND last_rejection_status IS NULL)),
  CHECK (state <> 'healthy' OR ever_succeeded),
  CHECK (state_since <= updated_at AND (last_rejection_at IS NULL OR
    (last_rejection_at >= state_since AND last_rejection_at <= updated_at)))
);`;

export const catalogOperatorSessionOutcomeSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261002_catalog_operator_session_outcomes_v1",
    description: "Retain credential-bound passive authentication outcomes without resetting custody.",
    statements: [catalogOperatorSessionOutcomeSchemaSql],
  },
];
