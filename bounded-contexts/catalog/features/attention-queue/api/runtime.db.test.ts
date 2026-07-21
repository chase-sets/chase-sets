import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { listSourceObservationAliasCandidates } from "../../alias-equivalence/read-model/queries";
import { listProposedProviderScopeMappings } from "../../provider-scope-mapping/read-model/queries";
import { listStaleActiveCatalogScopeRecords } from "../../scope-registry/read-model/queries";
import { catalogAttentionQueueRoutes } from "./route";
import { assembleCatalogAttentionQueue } from "./contracts";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const context: EventStoreContext = {
  tenantId: "tnt_test" as TenantId,
  audit: { performedByUserId: "usr_reviewer" as UserId, forAccountId: "acc_test" as AccountId },
};

const queueSchemaSql = `
CREATE TABLE catalog_provider_scope_mappings (
  mapping_id text PRIMARY KEY, scope_record_id text NOT NULL, provider_key text NOT NULL, unit_key text NOT NULL,
  product_line_id text, series_id text, set_id text, set_name text, language_coordinates jsonb NOT NULL,
  confidence text NOT NULL, review_status text NOT NULL, provenance jsonb NOT NULL, evidence jsonb NOT NULL,
  last_actor text, last_reason text, policy_version text NOT NULL,
  proposed_at timestamptz NOT NULL, reviewed_at timestamptz, updated_at timestamptz NOT NULL
);
CREATE TABLE catalog_source_observation_alias_candidates (
  alias_hash text PRIMARY KEY, target_kind text NOT NULL, target_id text, target_key text NOT NULL,
  alias_text text NOT NULL, normalized_alias_text text NOT NULL, alias_language_code text NOT NULL,
  source_language_code text, alias_type text NOT NULL, confidence text NOT NULL, review_status text NOT NULL,
  provider_key text NOT NULL, observation_id text, source_category text NOT NULL, source_profile_key text NOT NULL,
  source_profile_version text NOT NULL, mapping_fingerprint text NOT NULL, evidence jsonb NOT NULL,
  first_observed_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE catalog_scope_records (
  scope_record_id text PRIMARY KEY, product_domain text NOT NULL, scope_kind text NOT NULL,
  reference_type_key text NOT NULL, reference_record_id text NOT NULL, reference_record_key text NOT NULL,
  name_i18n jsonb NOT NULL, name text NOT NULL, parent_scope_record_id text, product_line_scope_record_id text,
  series_scope_record_id text, release_date text, official_set_code text, language_editions jsonb NOT NULL,
  attributes jsonb NOT NULL, relationships jsonb NOT NULL, lifecycle_status text NOT NULL, updated_at timestamptz NOT NULL
);`;

describeDb("catalog attention queue PostgreSQL timestamp boundary", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["catalog"], "catalog_attention_queue");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools!);
    await pools!.catalog.query(queueSchemaSql);
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("returns 200 with string observedAt values from proposed mappings, aliases, and stale scopes", async () => {
    const db = pools!.catalog;
    await db.query(`INSERT INTO catalog_provider_scope_mappings VALUES
      ('mapping-1', 'scope-1', 'tcgplayer', 'pokemon', NULL, NULL, 'sv1', 'Scarlet & Violet', '{}',
       'candidate', 'proposed', '{}', '{}', NULL, NULL, 'v1', '2026-06-01T00:00:00Z', NULL, '2026-06-01T00:00:00Z')`);
    await db.query(`INSERT INTO catalog_source_observation_alias_candidates VALUES
      ('alias-1', 'catalog-item', 'item-1', 'item-1', 'Charizard', 'charizard', 'en', NULL, 'printed-name',
       'candidate', 'pending', 'tcgplayer', NULL, 'import', 'profile', 'v1', 'fingerprint', '{}',
       '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z')`);
    await db.query(`INSERT INTO catalog_scope_records VALUES
      ('scope-1', 'pokemon', 'set', 'set', 'reference-1', 'sv1', '{}', 'Scarlet & Violet', NULL, NULL, NULL,
       NULL, NULL, '{}', '{}', '{}', 'active', '2026-06-03T00:00:00Z')`);

    const app = new Hono<CatalogAuthoringEnv>();
    app.use("/attention-queue/*", async (c, next) => {
      c.set("actor", { permissions: ["catalog.view"] });
      c.set("context", context);
      await next();
    });
    app.route(
      "/attention-queue",
      catalogAttentionQueueRoutes({
        catalogAttentionDismissalCommandHandler: undefined as never,
        getCatalogAttentionQueueReadModel: async () =>
          assembleCatalogAttentionQueue(
            {
              proposedScopeMappings: await listProposedProviderScopeMappings(db),
              mergeCandidates: [],
              unitReadiness: [],
              unitActivity: [],
              pendingAliasCandidates: await listSourceObservationAliasCandidates(db, { reviewStatuses: ["pending"] }),
              staleScopeRecords: await listStaleActiveCatalogScopeRecords(db, {
                before: "2026-06-17T00:00:00.000Z",
              }),
            },
            { generatedAt: "2026-06-17T00:00:00.000Z", dismissedItemKeys: new Set() },
          ),
      }),
    );

    const response = await app.request("/attention-queue");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ itemKey: string; observedAt: unknown }> };
    expect(body.items.map((item) => item.itemKey)).toEqual([
      "unmapped-scope:mapping-1",
      "stale-scope-sync:scope-1",
      "alias-candidate:alias-1",
    ]);
    expect(body.items.every((item) => typeof item.observedAt === "string")).toBe(true);
  });
});
