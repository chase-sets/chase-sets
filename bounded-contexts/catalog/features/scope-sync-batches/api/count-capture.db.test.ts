import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as catalogModule } from "../../../index";
import { previewCatalogSyncProviderParticipation } from "../../source-observations/api/catalog-sync-scope-planner";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import { createCatalogProviderIntegrationProfileVersionStore } from "../../source-observations/api/providers/provider-integration-profile-store";
import { createPgCatalogProviderOptionQueryCacheStore } from "../../source-observations/api/providers/provider-option-query-cache";
import {
  createScrydexOnePieceProviderAdapter,
  scrydexCountQuery,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY as cardUnit,
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY as sealedUnit,
} from "../../source-observations/api/providers/scrydex/adapter";
import type { ScopeSyncBatchPreview } from "../domain/batch";
import type { CountTarget } from "../domain/count-acquisition";
import { captureCountPlannerRead, countCapturePlannerReadSchema } from "../domain/count-capture-plan";
import { createCountStore, countAccountSlot } from "../read-model/count-store";
import type { ScopeSyncBatchSnapshot } from "../read-model/store";
import { createCountAcquisition } from "./count-acquisition";
import { collectCountCapturePlannerRead } from "./count-capture-context";
import { createScopeSyncCountRuntime } from "./count-runtime";
import { createScopeSyncBatchRuntime } from "./runtime";

// DB Profile Tests owns this proof; missing Postgres is an error, not a skipped PASS.
const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error("TEST_DATABASE_URL is required for the count-capture pre-confirm DB proof.");

// Ordinary confirm outcomes captured from pre-change main 4898d17f5c with these
// fixtures and times. A changed confirmation check fails this comparison.
const golden = "../tests/fixtures/count-capture-confirm-golden.txt";
const acquiredAt = "2026-10-13T08:03:01.500Z";
const plannedAt = "2026-10-13T08:04:10.000Z";
const versionAt = "2026-10-13T07:00:00.000Z";
const confirmCases = ["allowed", "blocked", "stale", "already-settled"] as const;
type ConfirmCase = (typeof confirmCases)[number];

describe("pre-confirm has no effect capability", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;
  let now = acquiredAt;
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic_9584",
    audit: { performedByUserId: "usr_synthetic_9584", forAccountId: "acc_synthetic_9584" },
  };
  const selection = { mode: "ids" as const, scopeRecordIds: ["scope-synthetic-op01"] };
  const ready = { creditedProviderRequestLimits: { scrydex: 10 } };
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base, ["catalog"], "count_capture_9584");
    await ensureMultiContextTestDatabases(base, urls);
    pools = createMultiContextTestPools(urls);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  // The real planner, Scrydex adapter, count runtime and Postgres for one OP01
  // scope with governed card and sealed counts acquired 68.5 seconds earlier.
  async function fixture() {
    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(catalogModule.schemaSql);
    now = acquiredAt;
    const profiles = createCatalogProviderIntegrationProfileVersionStore(pools.catalog);
    await profiles.seedProfileVersions();
    const store = createCountStore(pools.catalog, countAccountSlot("staging", "synthetic-revision"), () => now);
    await store.retainUsage({
      providerKey: "scrydex",
      creditUnit: "credit",
      creditState: "available",
      remainingCredits: 100,
      totalCredits: 100,
      usedCredits: 0,
      observedAt: acquiredAt,
      attemptedAt: acquiredAt,
      attemptState: "checked",
      providerUpdatedAt: null,
      lagCategory: "unobserved",
      diagnosticCode: null,
      diagnostic: null,
      freshWithinSeconds: 900,
      unavailableAfterSeconds: 900,
    });
    await pools.catalog.query(
      `INSERT INTO catalog_scope_records (scope_record_id,product_domain,scope_kind,reference_type_key,reference_record_id,reference_record_key,name,lifecycle_status,updated_at)
       VALUES ($1,'one-piece','set','one-piece-set','ref-synthetic-op01','OP01','Synthetic Romance Dawn','active',$2)`,
      [selection.scopeRecordIds[0], versionAt],
    );
    const targets: CountTarget[] = [];
    for (const [kind, unitKey] of [
      ["cards", cardUnit],
      ["sealed", sealedUnit],
    ] as const) {
      await pools.catalog.query(
        `INSERT INTO catalog_provider_scope_mappings (mapping_id,scope_record_id,provider_key,unit_key,set_id,set_name,confidence,review_status,policy_version,updated_at)
         VALUES ($1,$2,'scrydex',$3,'OP01','Synthetic Romance Dawn','exact','accepted','synthetic',$4)`,
        [`mapping-synthetic-${kind}`, selection.scopeRecordIds[0], unitKey, versionAt],
      );
      targets.push({
        scopeRecordId: selection.scopeRecordIds[0]!,
        source: null,
        blocked: false,
        query: scrydexCountQuery({
          environment: "staging",
          accountRevision: "synthetic-revision",
          productDomain: "one-piece",
          profileKey:
            kind === "cards"
              ? "one-piece-card-print-source-observation"
              : "one-piece-sealed-product-source-observation",
          profileVersion: "2026.06.22",
          unitKey,
          kind,
          languageCode: "en",
          parentValue: "OP01",
        }),
      });
    }
    const engine = createCountAcquisition({
      ledger: {
        ...store,
        admit: (quote, owner, authority) => store.admit(pools.catalog, quote, owner, authority),
        approve: (id, fingerprint, owner) => store.approve(pools.catalog, id, fingerprint, owner),
        claim: (quote, target, owner, authority, executionId) =>
          store.claim(pools.catalog, quote, target, owner, authority, executionId),
        end: (quoteId, executionId, owner, state) => store.end(pools.catalog, quoteId, executionId, owner, state),
      },
      resolve: async () => ({ membershipFingerprint: "synthetic-membership", targets }),
      send: async (query: CountTarget["query"]) => ({
        totalCount: query.kind === "cards" ? 121 : 7,
        pageSize: 100,
        returnedPage: 1 as const,
        returnedItemCount: query.kind === "cards" ? 100 : 7,
        observedAt: acquiredAt,
      }),
      allowed: () => true,
      now: () => now,
    });
    const quote = await engine.quote({ selection, owner: "synthetic-owner" });
    expect(
      (await engine.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "synthetic-owner" }))
        .state,
    ).toBe("complete");
    now = plannedAt;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (!String(input).includes("/account/v1/usage")) throw new Error("Unexpected synthetic provider call.");
      return Response.json({
        data: {
          credits_remaining: 100,
          total_credits_consumed: 0,
          overage_credits_consumed: 0,
          period_start: "2026-01-01T00:00:00Z",
          period_end: "2027-01-01T00:00:00Z",
        },
      });
    });
    const adapterOptions = {
      fetch,
      credentials: { apiKey: "synthetic", teamId: "synthetic" },
      baseUrl: "https://synthetic.fixture.local/onepiece/v1",
      now: () => new Date(now),
      profileVersions: profiles,
      cacheStore: createPgCatalogProviderOptionQueryCacheStore(pools.catalog)!,
      countReader: store,
      countEnvironment: "staging",
      countAccountRevision: "synthetic-revision",
    };
    const counts = createScopeSyncCountRuntime({
      pool: pools.catalog,
      store,
      environment: "staging",
      accountRevision: "synthetic-revision",
      profiles,
      adapterOptions,
      now: () => now,
    });
    const enqueue = vi.fn(async () => {
      throw new Error("enqueue trap");
    });
    const runtime = createScopeSyncBatchRuntime({
      db: pools.catalog,
      counts,
      now: () => now,
      enqueueCatalogSyncRun: enqueue,
      getCatalogSyncRun: vi.fn(async () => ({ status: "completed", childJobs: [] }) as never),
      cancelIntegrationJob: vi.fn(),
      previewCatalogSyncScope: async (input) =>
        previewCatalogSyncProviderParticipation({
          ...input,
          acceptedScopeMappings: input.acceptedScopeMappings ?? [],
          providerProfileVersions: await profiles.listProfileVersions(),
          providerAdapterRegistry: new ProviderAdapterRegistry([createScrydexOnePieceProviderAdapter(adapterOptions)]),
        }),
    });
    return { runtime, counts, enqueue, fetch };
  }

  async function settle(batchId: string) {
    await pools.catalog.query(
      "UPDATE catalog_scope_sync_batches SET status='completed', completed_at=$2 WHERE batch_id=$1",
      [batchId, plannedAt],
    );
    await pools.catalog.query(
      "UPDATE catalog_scope_sync_batch_units SET state='completed', sync_run_id='run-synthetic-settled', completed_at=$2 WHERE batch_id=$1",
      [batchId, plannedAt],
    );
  }

  // One confirm case on fresh fixtures. With `preConfirm`, the pre-confirm planner
  // read runs first with the same input confirm then receives.
  async function confirmCase(name: ConfirmCase, preConfirm: boolean) {
    const f = await fixture();
    const input = {
      selection,
      budget: name === "blocked" ? { creditedProviderRequestLimits: { scrydex: 1 } } : ready,
      context,
    };
    const preview = await f.runtime.preview(input);
    if (name === "already-settled")
      await settle((await f.runtime.confirm({ ...input, planFingerprint: preview.planFingerprint })).batchId);
    if (name === "stale")
      await pools.catalog.query("UPDATE catalog_provider_scope_mappings SET updated_at=$1 WHERE unit_key=$2", [
        "2026-10-13T07:30:00.000Z",
        sealedUnit,
      ]);
    const confirmation = { ...input, planFingerprint: preview.planFingerprint };
    // The pre-confirm read plans for real, so it makes its own usage reads; only
    // those are set aside. Every other provider call and effect must match.
    const calls = () => f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname);
    const before = calls().length;
    const check = preConfirm ? await f.runtime.preConfirmPlannerRead(confirmation) : null;
    const preConfirmCalls = calls().length - before;
    const confirmed = await f.runtime.confirm(confirmation).then(
      (batch) => ({ batch, error: null }),
      (error: Error & { code?: string; currentPreview?: ScopeSyncBatchPreview }) => ({ batch: null, error }),
    );
    const history = await pools.catalog.query<{ event_kind: string; count: string }>(
      "SELECT event_kind, count(*) FROM catalog_scope_sync_count_history GROUP BY event_kind ORDER BY event_kind",
    );
    const rows = async (table: string) =>
      Number((await pools.catalog.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]!.count);
    const outcome = {
      case: name,
      confirm: normalizedConfirm(confirmed, preview.planFingerprint),
      effects: {
        batches: await rows("catalog_scope_sync_batches"),
        units: await rows("catalog_scope_sync_batch_units"),
        countHistory: Object.fromEntries(history.rows.map((row) => [row.event_kind, Number(row.count)])),
        enqueues: f.enqueue.mock.calls.length,
        providerCalls: calls().filter((_, index) => index < before || index >= before + preConfirmCalls),
      },
    };
    return { preview, check, confirmed, outcome, preConfirmCalls };
  }

  it("pre-confirm has no effect capability", async () => {
    const f = await fixture();
    const input = { selection, budget: ready, context };
    const preview = await collectCountCapturePlannerRead(() => f.runtime.preview(input));
    expect(preview.value.confirmAllowed).toBe(true);
    expect(preview.plan.preview).toEqual(preview.value);
    const planFingerprint = preview.value.planFingerprint;

    const reserve = vi.spyOn(f.counts, "reserveBatch").mockRejectedValue(new Error("reserve trap"));
    const queries = vi.spyOn(pools.catalog, "query");
    const connect = vi.spyOn(pools.catalog, "connect");
    const observation = await collectCountCapturePlannerRead(() =>
      f.runtime.preConfirmPlannerRead({ ...input, planFingerprint }),
    );
    const statements = queries.mock.calls.map(([sql]) => String(sql));
    queries.mockRestore();
    connect.mockRestore();
    expect(observation.value).toEqual({
      comparedFingerprint: planFingerprint,
      currentFingerprint: planFingerprint,
      eligible: true,
      refusal: null,
      effectsCapability: false,
    });
    expect(observation.plan.preview.planFingerprint).toBe(planFingerprint);
    const byKind = (winners: typeof observation.winners) =>
      [...winners].sort((left, right) => left.query.kind.localeCompare(right.query.kind));
    expect(byKind(observation.winners).map((winner) => [winner.query.kind, winner.source?.validationKind])).toEqual([
      ["cards", "page-1-count"],
      ["sealed", "page-1-count"],
    ]);
    expect(byKind(observation.winners).map((winner) => winner.source)).toEqual(
      byKind(preview.winners).map((winner) => winner.source),
    );
    expect(observation.winners.every((winner) => winner.readAt === plannedAt)).toBe(true);
    expect(reserve).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(statements.length).toBeGreaterThan(0);
    expect(
      statements.filter((sql) => /catalog_scope_sync_batch|\b(INSERT|UPDATE|DELETE)\b|advisory/i.test(sql)),
    ).toEqual([]);
    for (const row of [
      captureCountPlannerRead({ requestId: "synthetic-preview", ...preview, preConfirm: null }),
      captureCountPlannerRead({ requestId: "synthetic-pre-confirm", ...observation, preConfirm: observation.value }),
    ])
      expect(countCapturePlannerReadSchema.safeParse(row).success).toBe(true);

    // Confirmation was allowed: the real confirm, untrapped, reserves that plan.
    reserve.mockRestore();
    const batch = await f.runtime.confirm({ ...input, planFingerprint });
    expect(batch).toMatchObject({ status: "queued", planFingerprint: observation.value.currentFingerprint });
  });

  it("ordinary confirm matches its pre-change golden for allowed, blocked, stale and already-settled plans", async () => {
    const outcomes = [];
    for (const name of confirmCases) outcomes.push((await confirmCase(name, false)).outcome);
    await expect(`${JSON.stringify(outcomes, null, 2)}\n`).toMatchFileSnapshot(golden);
  });

  it("pre-confirm reports the refusal or eligibility real confirm reaches, and leaves confirm's outcome unchanged", async () => {
    const outcomes = [];
    for (const name of confirmCases) {
      const { check, confirmed, outcome, preConfirmCalls } = await confirmCase(name, true);
      outcomes.push(outcome);
      // A real planner read, not a stub resolver: it read provider usage itself.
      expect(preConfirmCalls).toBeGreaterThan(0);
      const current = confirmed.batch?.planFingerprint ?? confirmed.error?.currentPreview?.planFingerprint;
      expect(check).toMatchObject({
        currentFingerprint: current,
        eligible: confirmed.error === null,
        refusal: confirmed.error?.code ?? null,
        effectsCapability: false,
      });
    }
    expect(`${JSON.stringify(outcomes, null, 2)}\n`).toBe(
      readFileSync(fileURLToPath(new URL(golden, import.meta.url)), "utf8"),
    );
  });
});

// Run-specific identifiers and fingerprints become their relation to the preview.
function normalizedConfirm(
  confirmed: {
    batch: ScopeSyncBatchSnapshot | null;
    error: (Error & { code?: string; currentPreview?: ScopeSyncBatchPreview }) | null;
  },
  previewFingerprint: string,
) {
  const preview = (value: ScopeSyncBatchPreview | undefined) =>
    value && { ...value, planFingerprint: value.planFingerprint === previewFingerprint ? "preview" : "changed" };
  if (confirmed.error)
    return {
      refused: confirmed.error.name,
      code: confirmed.error.code ?? null,
      message: confirmed.error.message,
      currentPreview: preview(confirmed.error.currentPreview) ?? null,
    };
  const batch = confirmed.batch!;
  return {
    status: batch.status,
    fastNoOp: batch.fastNoOp,
    circuitOpenProviders: batch.circuitOpenProviders,
    counts: batch.counts,
    units: batch.units.map(({ scopeRecordId, state, syncRunId, providerKeys, attemptCount, errorMessage }) => ({
      scopeRecordId,
      state,
      syncRunId,
      providerKeys,
      attemptCount,
      errorMessage,
    })),
    planFingerprint: batch.planFingerprint === previewFingerprint ? "preview" : "changed",
    preview: preview(batch.preview),
  };
}
