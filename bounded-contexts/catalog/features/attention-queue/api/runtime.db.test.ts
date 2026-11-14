import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
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
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type {
  CatalogIntegrationControlPlaneUnitReadiness,
  SourceObservationIntegrationJob,
} from "../../source-observations/api/runtime";
import type { CatalogAttentionItemKind } from "../read-model/attention-item";
import { catalogAttentionDismissalSchemaSql } from "../read-model/dismissal-schema";
import type { CatalogAttentionQueueReadModel } from "./contracts";
import { catalogAttentionQueueRoutes } from "./route";
import { createCatalogAttentionQueueRuntime } from "./runtime";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const context: EventStoreContext = {
  tenantId: "tnt_test" as TenantId,
  audit: { performedByUserId: "usr_reviewer" as UserId, forAccountId: "acc_test" as AccountId },
};

const GENERATED_AT = "2026-07-09T12:00:00.000Z";
// One hour after GENERATED_AT: defers that end in between have aged back in.
const DEFER_UNTIL = "2026-07-09T13:00:00.000Z";
const LATER = "2026-07-09T14:00:00.000Z";
const EXPIRED = "2026-07-09T11:00:00.000Z";

// Hand-made source tables with the columns the queue reads (plus the existing
// columns of the three earlier tables), and the real dismissal schema.
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
);
CREATE TABLE catalog_merge_candidates (
  candidate_id text PRIMARY KEY, scope_record_id text NOT NULL, status text NOT NULL, status_reason text,
  conflicts_json jsonb NOT NULL DEFAULT '[]'::jsonb, membership_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, stale_at timestamptz
);
CREATE TABLE catalog_merge_candidate_observations (
  candidate_id text NOT NULL, observation_id text NOT NULL, PRIMARY KEY (candidate_id, observation_id)
);
${catalogAttentionDismissalSchemaSql}`;

// Row ids are `prefix` plus a zero-padded ordinal, or plus md5(ordinal) for a
// cohort whose timestamps tie (so the id, not insertion order, breaks the tie).
// Timestamps start at `start` and advance one second per row unless tied.
type Seed = Readonly<{ prefix: string; count: number; start: string; tied?: boolean }>;

function seedId(seed: Seed): string {
  return seed.tied ? `$1 || md5(n::text)` : `$1 || lpad(n::text, 4, '0')`;
}

function seedAt(seed: Seed): string {
  return seed.tied ? `$2::timestamptz` : `$2::timestamptz + make_interval(secs => n)`;
}

async function seedMappings(db: PgQueryable, seed: Seed, reviewStatus = "proposed") {
  await db.query(
    `INSERT INTO catalog_provider_scope_mappings
     SELECT ${seedId(seed)}, 'scope-1', 'tcgdex', 'unit-1', NULL, NULL, 'sv1', 'SV', '{}'::jsonb, 'candidate', $4,
            '{"note":"provenance"}'::jsonb, '{"note":"evidence"}'::jsonb, NULL, NULL, 'v1',
            ${seedAt(seed)}, NULL, ${seedAt(seed)}
     FROM generate_series(1, $3) AS n`,
    [seed.prefix, seed.start, seed.count, reviewStatus],
  );
}

async function seedAliases(db: PgQueryable, seed: Seed, reviewStatus = "pending") {
  await db.query(
    `INSERT INTO catalog_source_observation_alias_candidates
     SELECT ${seedId(seed)}, 'catalog-item', 'item-1', 'item-1', 'Charizard', 'charizard', 'en', NULL, 'printed-name',
            'candidate', $4, 'tcgdex', NULL, 'import', 'profile', 'v1', 'fingerprint', '{"note":"evidence"}'::jsonb,
            ${seedAt(seed)}, ${seedAt(seed)}
     FROM generate_series(1, $3) AS n`,
    [seed.prefix, seed.start, seed.count, reviewStatus],
  );
}

async function seedScopes(db: PgQueryable, seed: Seed, lifecycleStatus = "active") {
  await db.query(
    `INSERT INTO catalog_scope_records
     SELECT ${seedId(seed)}, 'pokemon', 'set', 'set', 'reference-' || n, 'sv' || n, '{}'::jsonb, 'Set ' || n,
            NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, $4, ${seedAt(seed)}
     FROM generate_series(1, $3) AS n`,
    [seed.prefix, seed.start, seed.count, lifecycleStatus],
  );
}

async function seedMerges(db: PgQueryable, seed: Seed, status: string) {
  await db.query(
    `INSERT INTO catalog_merge_candidates
     SELECT ${seedId(seed)}, 'scope-1', $4, NULL,
            '[{"severity":"blocking"},{"severity":"warning"},{"severity":"blocking"}]'::jsonb,
            '[{"note":"membership"}]'::jsonb,
            ${seedAt(seed)}, ${seedAt(seed)}, CASE WHEN $4 = 'stale' THEN ${seedAt(seed)} ELSE NULL END
     FROM generate_series(1, $3) AS n`,
    [seed.prefix, seed.start, seed.count, status],
  );
}

async function park(db: PgQueryable, itemKey: string, deferredUntil: string | null = null) {
  await db.query(
    `INSERT INTO catalog_attention_dismissals (item_key, kind, disposition, reason, deferred_until, actor)
     VALUES ($1, split_part($1, ':', 1), $2, 'test', $3, 'op')`,
    [itemKey, deferredUntil === null ? "dismissed" : "deferred", deferredUntil],
  );
}

function blockedUnit(unitKey: string): CatalogIntegrationControlPlaneUnitReadiness {
  return {
    unitKey,
    providerKey: "tcgdex",
    displayName: unitKey,
    productDomain: "pokemon",
    productForm: "sealed",
    ingestionPurpose: null,
    profileVersion: "v1",
    semanticReadiness: "ready",
    credentialReadiness: "blocked",
    credentialReadinessState: "expired",
    credentialRequirement: "required",
    credentialDiagnosticCode: "cred.expired",
    transportReadiness: "ready",
    fixtureValidationStatus: "ready",
    dryRunStatus: "completed",
    observationFacts: 0,
    diagnosticCounts: { info: 0, warning: 0, error: 1 },
    diagnostics: [],
    latestDiagnosticText: null,
    dryRunEvidence: [],
  };
}

function failedJob(jobId: string, unitKey: string): SourceObservationIntegrationJob {
  return {
    jobId,
    syncRunId: null,
    action: "import",
    scope: { provider: "tcgdex", ingestionUnitKey: unitKey, language: "en", setId: "sv1" },
    profileSnapshot: null,
    reapplyProfileMode: null,
    status: "completed",
    operatorStatus: "failed",
    consistency: {
      duplicateSubmissionPolicy: "reuse-active-job",
      profileSnapshotPolicy: "snapshotted-at-enqueue",
      retryResumePolicy: "skip-completed-outcomes",
      partialFailurePolicy: "mixed-outcomes",
      workUnitClaimPolicy: "leased-job-turns",
    },
    progress: { phase: "completed", completed: 0, total: 1, currentName: null, status: "failed" },
    result: null,
    errorMessage: null,
    createdAt: "2026-07-08T00:00:00.000Z",
    startedAt: "2026-07-08T00:00:00.000Z",
    completedAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

// The real queue runtime over PostgreSQL behind the real HTTP route, with the
// control plane observed in memory and a fixed queue clock.
function queueApp(
  db: PgQueryable,
  input: Readonly<{
    generatedAt?: string;
    units?: readonly CatalogIntegrationControlPlaneUnitReadiness[];
    jobs?: readonly SourceObservationIntegrationJob[];
  }> = {},
) {
  const runtime = createCatalogAttentionQueueRuntime({ db } as object as CatalogRuntimeDeps, {
    getReadiness: async () => ({
      generatedAt: GENERATED_AT,
      rolloutControls: { generatedAt: GENERATED_AT, controls: [] },
      providerUsage: [],
      units: input.units ?? [],
    }),
    listActiveJobSnapshot: async () => ({ items: input.jobs ?? [], completeness: "complete" }),
  });
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
      getCatalogAttentionQueueReadModel: (request) =>
        runtime.getCatalogAttentionQueueReadModel({ ...request, generatedAt: input.generatedAt ?? GENERATED_AT }),
    }),
  );
  return app;
}

async function getQueue(app: Hono<CatalogAuthoringEnv>, search = ""): Promise<CatalogAttentionQueueReadModel> {
  const response = await app.request(`/attention-queue${search ? `?${search}` : ""}`);
  expect(response.status).toBe(200);
  return (await response.json()) as CatalogAttentionQueueReadModel;
}

function keysOf(queue: CatalogAttentionQueueReadModel, kind: CatalogAttentionItemKind): string[] {
  return queue.items.filter((item) => item.kind === kind).map((item) => item.itemKey);
}

// Follow `nextOffset` from 0 with maximal windows until the kind reports no more counted work.
async function walkKind(app: Hono<CatalogAuthoringEnv>, kind: CatalogAttentionItemKind) {
  const pages: CatalogAttentionQueueReadModel[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await getQueue(app, `kind=${kind}&limit=200&offset=${offset}`);
    pages.push(page);
    offset = page.coverage[kind].nextOffset;
    expect(pages.length).toBeLessThan(10);
  }
  return { pages, keys: pages.flatMap((page) => keysOf(page, kind)) };
}

async function ids(db: PgQueryable, sql: string, prefix: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(sql, [`${prefix}%`]);
  return result.rows.map((row) => row.id);
}

describeDb("catalog attention queue PostgreSQL sources", () => {
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
    // Negative control: `timestamptz::text` would emit a Chicago offset here.
    await db.query("SET TIME ZONE 'America/Chicago'");
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

    const body = await getQueue(queueApp(db, { generatedAt: "2026-06-20T00:00:00.000Z" }));
    expect(body.items.map((item) => item.itemKey)).toEqual([
      "unmapped-scope:mapping-1",
      "stale-scope-sync:scope-1",
      "alias-candidate:alias-1",
    ]);
    expect(body.items.every((item) => typeof item.observedAt === "string")).toBe(true);
    expect(body.items.map((item) => item.observedAt)).toEqual([
      "2026-06-01T00:00:00.000000Z",
      "2026-06-03T00:00:00.000000Z",
      "2026-06-02T00:00:00.000000Z",
    ]);
    expect(
      body.items.every((item) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(String(item.observedAt))),
    ).toBe(true);
  });

  it("counts 201 eligible rows per database kind past the first window, excluding ineligible and parked rows", async () => {
    const db = pools!.catalog;
    // Unmapped scopes: 200 proposed plus a 201st whose defer expired before GENERATED_AT.
    await seedMappings(db, { prefix: "map-a", count: 200, start: "2026-06-01T00:00:00Z" });
    await seedMappings(db, { prefix: "map-b", count: 1, start: "2026-06-30T00:00:00Z" });
    await park(db, "unmapped-scope:map-b0001", EXPIRED);
    await seedMappings(db, { prefix: "map-p", count: 2, start: "2026-06-01T00:00:00Z" });
    await park(db, "unmapped-scope:map-p0001");
    await park(db, "unmapped-scope:map-p0002", DEFER_UNTIL);
    await seedMappings(db, { prefix: "map-x-accepted", count: 1, start: "2026-06-01T00:00:00Z" }, "accepted");
    await seedMappings(db, { prefix: "map-x-rejected", count: 1, start: "2026-06-01T00:00:00Z" }, "rejected");
    // Merge candidates: 201 per queue status, one parked conflict, and every other status.
    await seedMerges(db, { prefix: "merge-c", count: 201, start: "2026-06-01T00:00:00Z" }, "has-conflicts");
    await seedMerges(db, { prefix: "merge-s", count: 201, start: "2026-06-01T00:00:00Z" }, "stale");
    await seedMerges(db, { prefix: "merge-p", count: 1, start: "2026-06-01T00:00:00Z" }, "has-conflicts");
    await park(db, "merge-conflict:merge-p0001");
    for (const status of ["ready", "promoted", "deferred", "rejected"]) {
      await seedMerges(db, { prefix: `merge-x-${status}`, count: 1, start: "2026-06-01T00:00:00Z" }, status);
    }
    await db.query(
      `INSERT INTO catalog_merge_candidate_observations VALUES ('merge-c0001', 'obs-1'), ('merge-c0001', 'obs-2')`,
    );
    // Alias candidates: 201 pending, one parked, and resolved statuses.
    await seedAliases(db, { prefix: "alias-a", count: 201, start: "2026-06-01T00:00:00Z" });
    await seedAliases(db, { prefix: "alias-p", count: 1, start: "2026-06-01T00:00:00Z" });
    await park(db, "alias-candidate:alias-p0001");
    await seedAliases(db, { prefix: "alias-x-auto", count: 1, start: "2026-06-01T00:00:00Z" }, "auto-accepted");
    await seedAliases(db, { prefix: "alias-x-rejected", count: 1, start: "2026-06-01T00:00:00Z" }, "rejected");
    // Stale scope syncs: 201 active and older than the window, one deferred, fresh/draft/retired controls.
    await seedScopes(db, { prefix: "scope-a", count: 201, start: "2026-06-01T00:00:00Z" });
    await seedScopes(db, { prefix: "scope-p", count: 1, start: "2026-06-01T00:00:00Z" });
    await park(db, "stale-scope-sync:scope-p0001", DEFER_UNTIL);
    await seedScopes(db, { prefix: "scope-x-fresh", count: 1, start: "2026-07-01T00:00:00Z" });
    await seedScopes(db, { prefix: "scope-x-draft", count: 1, start: "2026-06-01T00:00:00Z" }, "draft");
    await seedScopes(db, { prefix: "scope-x-retired", count: 1, start: "2026-06-01T00:00:00Z" }, "retired");

    const app = queueApp(db);
    const summary = await getQueue(app);
    expect(summary.counts.byKind).toEqual({
      "unmapped-scope": 201,
      "merge-conflict": 402,
      "provider-health": 0,
      "import-job": 0,
      "alias-candidate": 201,
      "stale-scope-sync": 201,
    });
    expect(summary.counts.bySeverity).toEqual({ critical: 201, warning: 603, info: 201 });
    expect(summary.counts.total).toBe(1005);
    expect(summary.countBasis.total).toBe("exact");
    expect(summary.empty).toBe(false);
    expect(summary.items).toHaveLength(80);
    for (const kind of ["unmapped-scope", "merge-conflict", "alias-candidate", "stale-scope-sync"] as const) {
      expect(summary.coverage[kind]).toMatchObject({
        offset: 0,
        limit: 20,
        returned: 20,
        truncated: true,
        nextOffset: 20,
      });
    }
    // Conflicts lead the merge window, oldest first; counts are computed in SQL.
    expect(keysOf(summary, "merge-conflict")).toEqual(
      Array.from({ length: 20 }, (_, index) => `merge-conflict:merge-c${String(index + 1).padStart(4, "0")}`),
    );
    const firstConflict = summary.items.find((item) => item.itemKey === "merge-conflict:merge-c0001")!;
    expect(firstConflict.titleParams).toMatchObject({ conflicts: 2 });
    expect(firstConflict.detailParams).toMatchObject({ observations: 2 });

    // Position 201 is returned on the second maximal window, and only it.
    for (const [kind, key] of [
      ["unmapped-scope", "unmapped-scope:map-b0001"],
      ["alias-candidate", "alias-candidate:alias-a0201"],
      ["stale-scope-sync", "stale-scope-sync:scope-a0201"],
    ] as const) {
      const tail = await getQueue(app, `kind=${kind}&limit=200&offset=200`);
      expect(tail.items.map((item) => item.itemKey)).toEqual([key]);
      expect(tail.coverage[kind]).toMatchObject({ total: 201, returned: 1, truncated: false, nextOffset: null });
      expect(tail.counts.total).toBe(1005);
    }
    const mergeWalk = await walkKind(app, "merge-conflict");
    expect(mergeWalk.pages.map((page) => page.items.length)).toEqual([200, 200, 2]);
    expect(new Set(mergeWalk.keys).size).toBe(402);
    expect(mergeWalk.keys.slice(200, 202)).toContain("merge-conflict:merge-c0201");

    // A tail row changes the total, not the first window.
    await seedMappings(db, { prefix: "map-c", count: 1, start: "2026-07-01T00:00:00Z" });
    const grown = await getQueue(app);
    expect(grown.coverage["unmapped-scope"]).toMatchObject({ total: 202, returned: 20 });
    expect(keysOf(grown, "unmapped-scope")).toEqual(keysOf(summary, "unmapped-scope"));
  });

  it("judges dismissals and defers at one generatedAt for database and observed sources", async () => {
    const db = pools!.catalog;
    await seedMappings(db, { prefix: "map-", count: 3, start: "2026-06-01T00:00:00Z" });
    await park(db, "unmapped-scope:map-0001");
    await park(db, "unmapped-scope:map-0002", DEFER_UNTIL);
    await seedMerges(db, { prefix: "merge-c", count: 2, start: "2026-06-01T00:00:00Z" }, "has-conflicts");
    await park(db, "merge-conflict:merge-c0001", DEFER_UNTIL);
    await park(db, "provider-health:tcgdex:unit-1", DEFER_UNTIL);
    await park(db, "import-job:job-1");
    const observed = {
      units: [blockedUnit("unit-1")],
      jobs: [failedJob("job-1", "unit-1"), failedJob("job-2", "unit-1")],
    };

    const now = await getQueue(queueApp(db, { ...observed, generatedAt: GENERATED_AT }));
    expect(now.counts.byKind).toMatchObject({
      "unmapped-scope": 1,
      "merge-conflict": 1,
      "provider-health": 0,
      "import-job": 1,
    });
    expect(now.items.map((item) => item.itemKey).sort()).toEqual([
      "import-job:job-2",
      "merge-conflict:merge-c0002",
      "unmapped-scope:map-0003",
    ]);

    // Past the defer window every deferred item ages back in; dismissals stay parked.
    const later = await getQueue(queueApp(db, { ...observed, generatedAt: LATER }));
    expect(later.counts.byKind).toMatchObject({
      "unmapped-scope": 2,
      "merge-conflict": 2,
      "provider-health": 1,
      "import-job": 1,
    });
    expect(keysOf(later, "unmapped-scope").sort()).toEqual(["unmapped-scope:map-0002", "unmapped-scope:map-0003"]);
    expect(keysOf(later, "import-job")).toEqual(["import-job:job-2"]);

    // Restoring a dismissal removes its row, and the item counts again.
    await db.query(`DELETE FROM catalog_attention_dismissals WHERE item_key = 'unmapped-scope:map-0001'`);
    const restored = await getQueue(queueApp(db, { ...observed, generatedAt: LATER }));
    expect(restored.counts.byKind["unmapped-scope"]).toBe(3);
  });

  it("walks an unchanged 401-row cohort with tied timestamps per kind and sees each eligible key exactly once", async () => {
    const db = pools!.catalog;
    const tiedAt = "2026-06-01T00:00:00Z";
    await seedMappings(db, { prefix: "map-t-", count: 400, start: tiedAt, tied: true });
    await seedMappings(db, { prefix: "map-t-resurfaced-", count: 1, start: tiedAt, tied: true });
    const [resurfaced] = await ids(
      db,
      `SELECT mapping_id AS id FROM catalog_provider_scope_mappings WHERE mapping_id LIKE $1`,
      "map-t-resurfaced-",
    );
    await park(db, `unmapped-scope:${resurfaced}`, EXPIRED);
    await seedMappings(db, { prefix: "map-p-", count: 2, start: tiedAt, tied: true });
    const parkedMappings = await ids(
      db,
      `SELECT mapping_id AS id FROM catalog_provider_scope_mappings WHERE mapping_id LIKE $1`,
      "map-p-",
    );
    await park(db, `unmapped-scope:${parkedMappings[0]}`);
    await park(db, `unmapped-scope:${parkedMappings[1]}`, DEFER_UNTIL);
    await seedAliases(db, { prefix: "alias-t-", count: 401, start: tiedAt, tied: true });
    await seedAliases(db, { prefix: "alias-p-", count: 1, start: tiedAt, tied: true });
    const [parkedAlias] = await ids(
      db,
      `SELECT alias_hash AS id FROM catalog_source_observation_alias_candidates WHERE alias_hash LIKE $1`,
      "alias-p-",
    );
    await park(db, `alias-candidate:${parkedAlias}`);
    await seedScopes(db, { prefix: "scope-t-", count: 401, start: tiedAt, tied: true });
    await seedScopes(db, { prefix: "scope-p-", count: 1, start: tiedAt, tied: true });
    const [parkedScope] = await ids(
      db,
      `SELECT scope_record_id AS id FROM catalog_scope_records WHERE scope_record_id LIKE $1`,
      "scope-p-",
    );
    await park(db, `stale-scope-sync:${parkedScope}`, DEFER_UNTIL);
    await seedMerges(db, { prefix: "merge-t-c-", count: 201, start: tiedAt, tied: true }, "has-conflicts");
    await seedMerges(db, { prefix: "merge-t-s-", count: 200, start: tiedAt, tied: true }, "stale");
    await seedMerges(db, { prefix: "merge-p-", count: 1, start: tiedAt, tied: true }, "stale");
    const [parkedMerge] = await ids(
      db,
      `SELECT candidate_id AS id FROM catalog_merge_candidates WHERE candidate_id LIKE $1`,
      "merge-p-",
    );
    await park(db, `merge-conflict:${parkedMerge}`);

    // The seed classification, not the queue predicates, says which keys are eligible.
    const expected: Record<"unmapped-scope" | "alias-candidate" | "stale-scope-sync" | "merge-conflict", string[]> = {
      "unmapped-scope": (
        await ids(db, `SELECT mapping_id AS id FROM catalog_provider_scope_mappings WHERE mapping_id LIKE $1`, "map-t-")
      ).map((id) => `unmapped-scope:${id}`),
      "alias-candidate": (
        await ids(
          db,
          `SELECT alias_hash AS id FROM catalog_source_observation_alias_candidates WHERE alias_hash LIKE $1`,
          "alias-t-",
        )
      ).map((id) => `alias-candidate:${id}`),
      "stale-scope-sync": (
        await ids(
          db,
          `SELECT scope_record_id AS id FROM catalog_scope_records WHERE scope_record_id LIKE $1`,
          "scope-t-",
        )
      ).map((id) => `stale-scope-sync:${id}`),
      "merge-conflict": (
        await ids(db, `SELECT candidate_id AS id FROM catalog_merge_candidates WHERE candidate_id LIKE $1`, "merge-t-")
      ).map((id) => `merge-conflict:${id}`),
    };

    const app = queueApp(db);
    for (const [kind, keys] of Object.entries(expected) as Array<[keyof typeof expected, string[]]>) {
      expect(keys).toHaveLength(401);
      const first = await walkKind(app, kind);
      expect(first.pages.map((page) => page.items.length)).toEqual([200, 200, 1]);
      expect(first.pages.every((page) => page.coverage[kind].total === 401)).toBe(true);
      // Count and list share one predicate: the walked keys are exactly the counted cohort.
      expect(new Set(first.keys).size).toBe(401);
      expect([...first.keys].sort()).toEqual([...keys].sort());
      // The order is total, so an unchanged cohort pages identically every time.
      const second = await walkKind(app, kind);
      expect(second.pages.map((page) => keysOf(page, kind))).toEqual(first.pages.map((page) => keysOf(page, kind)));

      const beyond = await getQueue(app, `kind=${kind}&limit=200&offset=1000`);
      expect(beyond.items).toEqual([]);
      expect(beyond.coverage[kind]).toMatchObject({ total: 401, returned: 0, truncated: false, nextOffset: null });
    }
    // Conflicts precede stale candidates across the merge walk.
    const merge = await walkKind(app, "merge-conflict");
    const statuses = merge.keys.map((key) => (key.startsWith("merge-conflict:merge-t-c-") ? "c" : "s"));
    expect(statuses.indexOf("s")).toBe(201);
    expect(statuses.lastIndexOf("c")).toBe(200);
  });
});
