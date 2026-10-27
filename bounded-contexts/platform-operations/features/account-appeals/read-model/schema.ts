import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

/**
 * The Appealable Enforcement Action registry: one row per enforcement action id, holding the
 * immutable attribution tuple (owner, source discriminator, source stream id and version) taken
 * from the source event. `conflict_state` turns `conflicted` once any later delivery claims the
 * same id with a different tuple, and it is never cleared by replay.
 */
const appealableActionsTableSql = `CREATE TABLE IF NOT EXISTS platform_operations_account_appealable_actions (
  appealable_action_id text PRIMARY KEY,
  owner_account_id text NOT NULL,
  source text NOT NULL CHECK (source IN (
    'identity.account.suspended',
    'identity.account.reactivated',
    'identity.account.closed',
    'marketplace.listing.operator-unlisted',
    'marketplace.listing.auto-unlisted'
  )),
  source_stream_id text NOT NULL,
  source_stream_version integer NOT NULL CHECK (source_stream_version > 0),
  conflict_state text NOT NULL DEFAULT 'clear' CHECK (conflict_state IN ('clear', 'conflicted'))
)`;

const accountAppealSellerHistoryTableSql = `CREATE TABLE IF NOT EXISTS platform_operations_account_appeal_seller_history (
  appeal_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  appealable_action_id text NOT NULL,
  appealable_action_source text NOT NULL,
  appealable_action_source_stream_id text NOT NULL,
  appealable_action_source_stream_version integer NOT NULL CHECK (appealable_action_source_stream_version > 0),
  statement text NOT NULL,
  filed_by_user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('filed', 'in-review', 'upheld', 'reversed', 'modified', 'withdrawn')),
  outcome text NULL CHECK (outcome IS NULL OR outcome IN ('upheld', 'reversed', 'modified')),
  rationale text NULL,
  stream_version integer NOT NULL CHECK (stream_version > 0)
)`;

const accountAppealOperatorHistoryTableSql = `CREATE TABLE IF NOT EXISTS platform_operations_account_appeal_operator_history (
  appeal_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  appealable_action_id text NOT NULL,
  appealable_action_source text NOT NULL,
  appealable_action_source_stream_id text NOT NULL,
  appealable_action_source_stream_version integer NOT NULL CHECK (appealable_action_source_stream_version > 0),
  statement text NOT NULL,
  filed_by_user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('filed', 'in-review', 'upheld', 'reversed', 'modified', 'withdrawn')),
  outcome text NULL CHECK (outcome IS NULL OR outcome IN ('upheld', 'reversed', 'modified')),
  rationale text NULL,
  stream_version integer NOT NULL CHECK (stream_version > 0),
  note text NULL,
  operator_user_id text NULL
)`;

/** Boot schema and migration are composed from this one array, so they cannot drift. */
export const accountAppealSchemaStatements: readonly string[] = [
  appealableActionsTableSql,
  accountAppealSellerHistoryTableSql,
  accountAppealOperatorHistoryTableSql,
];

export const accountAppealSchemaSql = `${accountAppealSchemaStatements.join(";\n\n")};\n`;

export const accountAppealSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261021_platform_operations_account_appealable_actions",
    description:
      "Create the Appealable Enforcement Action registry for databases booted before it existed, from the same " +
      "statement array as the boot schema.",
    statements: [appealableActionsTableSql],
  },
  {
    migrationId: "20261026_platform_operations_account_appeal_projections",
    description: "Create replay-safe seller and operator account appeal projections.",
    statements: [accountAppealSellerHistoryTableSql, accountAppealOperatorHistoryTableSql],
  },
];
