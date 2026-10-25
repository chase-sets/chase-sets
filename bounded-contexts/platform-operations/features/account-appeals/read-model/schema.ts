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

/** Boot schema and migration are composed from this one array, so they cannot drift. */
export const accountAppealSchemaStatements: readonly string[] = [appealableActionsTableSql];

export const accountAppealSchemaSql = `${accountAppealSchemaStatements.join(";\n\n")};\n`;

export const accountAppealSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261021_platform_operations_account_appealable_actions",
    description:
      "Create the Appealable Enforcement Action registry for databases booted before it existed, from the same " +
      "statement array as the boot schema.",
    statements: accountAppealSchemaStatements,
  },
];
