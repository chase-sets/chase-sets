import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PlatformControlPlane, PlatformLease } from "@chase-sets/platform-runtime/control-plane";
import { createProjectionGroupRunnerLeaseName, tryRunWithRenewedLease } from "@chase-sets/platform-runtime/worker";
import { aliasSearchContributionEnabled } from "../../features/search/domain/alias-rollout";
import {
  buildDiscoverySearchIdentityTerms,
  rebuildDiscoverySearchIndex,
  type DiscoverySearchIndexRebuildOptions,
} from "../../features/search/read-model/projection";

const projectionName = "discovery-search-item-projection";
const leaseName = createProjectionGroupRunnerLeaseName({ targetContextName: "discovery", projectionName });
const ttlMs = 30_000;

export async function verifyDiscoverySearchIdentityTerms(db: PgQueryable) {
  let after = "";
  let items = 0;
  let terms = 0;
  for (;;) {
    const page = await db.query<{
      catalog_item_id: string;
      title: string;
      subtitle: string | null;
      status: string;
      resolved_aliases: unknown;
      terms: string[];
    }>(
      `SELECT item.catalog_item_id, item.title, item.subtitle, item.status, source.resolved_aliases,
         ARRAY(SELECT term FROM discovery_search_item_identity_terms AS vocabulary
           WHERE vocabulary.catalog_item_id = item.catalog_item_id ORDER BY term) AS terms
       FROM discovery_search_items AS item
       LEFT JOIN discovery_search_catalog_items AS source USING (catalog_item_id)
       WHERE item.catalog_item_id > $1 ORDER BY item.catalog_item_id LIMIT 500`,
      [after],
    );
    for (const item of page.rows) {
      const expected = item.status === "active" ? buildDiscoverySearchIdentityTerms(item) : [];
      const actual = [...item.terms].sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw new Error(`Identity-term set equality failed for '${item.catalog_item_id}'.`);
      }
      items += 1;
      terms += actual.length;
    }
    if (page.rows.length < 500) break;
    after = page.rows[page.rows.length - 1].catalog_item_id;
  }
  const invalid = await db.query(
    `SELECT term.catalog_item_id FROM discovery_search_item_identity_terms AS term
     LEFT JOIN discovery_search_items AS item USING (catalog_item_id)
     LEFT JOIN discovery_search_catalog_items AS source USING (catalog_item_id)
     WHERE item.catalog_item_id IS NULL OR source.catalog_item_id IS NULL
       OR item.status <> 'active' OR source.status IN ('archived', 'retired') LIMIT 1`,
  );
  if (invalid.rows.length) throw new Error("Identity terms contain orphaned or inactive items.");
  return { items, terms, setEquality: true as const };
}

export async function populateDiscoverySearchIdentityTerms(
  input: Readonly<{
    pool: PgTransactionalPool;
    controlPlane: PlatformControlPlane;
    ownerId: string;
    writerSha: string;
    environment: "local" | "staging" | "production";
    authorization: string;
    rebuildOptions?: DiscoverySearchIndexRebuildOptions;
  }>,
) {
  if (!/^[a-f0-9]{40}$/.test(input.writerSha) || !input.authorization.trim()) {
    throw new Error("Population requires the deployed writer SHA and operator authorization reference.");
  }
  let heldLease: PlatformLease | null = null;
  const outcome = await tryRunWithRenewedLease(
    {
      ...input.controlPlane,
      acquireLease: async (request) => {
        heldLease = await input.controlPlane.acquireLease(request);
        return heldLease;
      },
    },
    { leaseName, ownerId: input.ownerId, ttlMs, renewIntervalMs: 5_000 },
    async (context) =>
      withPgTransaction(input.pool, async (client) => {
        const db: PgQueryable = {
          query: async (sql, values) => {
            context.throwIfLeaseLost?.();
            const result = await client.query(sql, values);
            context.throwIfLeaseLost?.();
            return result;
          },
        };
        await db.query(`SET LOCAL statement_timeout = '120s'`);
        await db.query(`SET LOCAL idle_in_transaction_session_timeout = '15s'`);
        const capabilities = await db.query<{
          database_role: string;
          extension_version: string | null;
          migration_applied: boolean;
          index_valid: boolean;
        }>(`SELECT current_user AS database_role,
        (SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm') AS extension_version,
        EXISTS (SELECT 1 FROM bounded_context_schema_migrations
          WHERE migration_id = '20261008_discovery_search_identity_terms') AS migration_applied,
        EXISTS (SELECT 1 FROM pg_index AS i JOIN pg_class AS c ON c.oid = i.indexrelid
          JOIN pg_am AS am ON am.oid = c.relam
          JOIN pg_opclass AS op ON op.oid = i.indclass[0]
          WHERE i.indrelid = 'discovery_search_item_identity_terms'::regclass
            AND i.indisvalid AND am.amname = 'gin' AND op.opcname = 'gin_trgm_ops') AS index_valid`);
        const capability = capabilities.rows[0];
        if (!capability?.extension_version || !capability.migration_applied || !capability.index_valid) {
          throw new Error(
            "Identity-term migration/pg_trgm/index is not ready; operator must repair deployment before retry.",
          );
        }
        const checkpoints = async () =>
          (
            await db.query(
              `SELECT * FROM event_subscription_checkpoints WHERE projection_name = $1 ORDER BY checkpoint_key`,
              [projectionName],
            )
          ).rows;
        const checkpointsBefore = await checkpoints();
        await rebuildDiscoverySearchIndex(db, input.rebuildOptions);
        const verification = await verifyDiscoverySearchIdentityTerms(db);
        const checkpointsAfter = await checkpoints();
        if (JSON.stringify(checkpointsBefore) !== JSON.stringify(checkpointsAfter)) {
          throw new Error("Population changed the search subscription checkpoints.");
        }
        // Revalidate the actual fence immediately before the transaction helper commits.
        if (!heldLease || !(await input.controlPlane.renewLease(heldLease, ttlMs))) {
          throw new Error(`Lost lease '${leaseName}' before population commit.`);
        }
        context.throwIfLeaseLost?.();
        return {
          schemaVersion: 1,
          environment: input.environment,
          deployedWriterSha: input.writerSha,
          authorization: input.authorization,
          aliasSearchEnabled: aliasSearchContributionEnabled(),
          lease: { leaseName, ownerId: context.ownerId, fencingToken: context.fencingToken },
          capabilities: capability,
          checkpointsBefore,
          checkpointsAfter,
          checkpointsUnchanged: true,
          pairedCutover: true,
          verification,
        };
      }),
  );
  if (!outcome.acquired) throw new Error(`Population did not execute: writer lease '${leaseName}' is occupied.`);
  return { ...outcome.result, committedAt: new Date().toISOString() };
}
