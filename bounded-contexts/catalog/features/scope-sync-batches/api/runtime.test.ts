import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { t } from "@chase-sets/localization";
import { module as catalogModule } from "../../../index";
import { createCountStore, countAccountSlot } from "../read-model/count-store";
import { createCountAcquisition } from "./count-acquisition";
import { createScopeSyncBatchRuntime } from "./runtime";
import { createScopeSyncCountRuntime } from "./count-runtime";
import { previewCatalogSyncProviderParticipation } from "../../source-observations/api/catalog-sync-scope-planner";
import { createCatalogProviderIntegrationProfileVersionStore } from "../../source-observations/api/providers/provider-integration-profile-store";
import { createPgCatalogProviderOptionQueryCacheStore } from "../../source-observations/api/providers/provider-option-query-cache";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import {
  createScrydexOnePieceProviderAdapter,
  scrydexCountQuery,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY as cardUnit,
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY as sealedUnit,
} from "../../source-observations/api/providers/scrydex/adapter";
import { countQueryKey, type CountTarget } from "../domain/count-acquisition";
import type { ScopeSyncBatchBudget } from "../domain/batch";

// DB Profile Tests owns this proof; missing Postgres is an error, not a skipped PASS.
const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error("TEST_DATABASE_URL is required for #9424 real batch runtime proof.");

describe("#9424 real sealed Scope Sync Batch runtime", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;
  let now: string;
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic_9424",
    audit: { performedByUserId: "usr_synthetic_9424", forAccountId: "acc_synthetic_9424" },
  };
  const selection = { mode: "ids" as const, scopeRecordIds: ["scope-synthetic-a", "scope-synthetic-b"] };
  const budget = { creditedProviderRequestLimits: { scrydex: 6 } };
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base, ["catalog"], "sealed_batch_runtime_9424");
    await ensureMultiContextTestDatabases(base, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(catalogModule.schemaSql);
    now = new Date().toISOString();
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function fixture() {
    const profiles = createCatalogProviderIntegrationProfileVersionStore(pools.catalog);
    await profiles.seedProfileVersions();
    const store = createCountStore(pools.catalog, countAccountSlot("test", "synthetic-revision"), () => now);
    await store.retainUsage({
      providerKey: "scrydex",
      creditUnit: "credit",
      creditState: "available",
      remainingCredits: 100,
      totalCredits: 100,
      usedCredits: 0,
      observedAt: now,
      attemptedAt: now,
      attemptState: "checked",
      providerUpdatedAt: null,
      lagCategory: "unobserved",
      diagnosticCode: null,
      diagnostic: null,
      freshWithinSeconds: 900,
      unavailableAfterSeconds: 900,
    });
    const targets: CountTarget[] = [];
    for (const [index, id] of selection.scopeRecordIds.entries()) {
      const parentValue = `OP0${index + 1}`;
      await pools.catalog.query(
        `INSERT INTO catalog_scope_records (scope_record_id,product_domain,scope_kind,reference_type_key,reference_record_id,reference_record_key,name,lifecycle_status)
         VALUES ($1,'one-piece','set','one-piece-set',$2,$3,'Synthetic Set','active')`,
        [id, `ref-synthetic-${index}`, parentValue],
      );
      for (const [kind, unitKey] of [
        ["cards", cardUnit],
        ["sealed", sealedUnit],
      ] as const) {
        await pools.catalog.query(
          `INSERT INTO catalog_provider_scope_mappings (mapping_id,scope_record_id,provider_key,unit_key,set_id,set_name,confidence,review_status,policy_version)
           VALUES ($1,$2,'scrydex',$3,$4,'Synthetic Set','exact','accepted','synthetic')`,
          [`mapping-${index}-${kind}`, id, unitKey, parentValue],
        );
        targets.push({
          scopeRecordId: id,
          source: null,
          blocked: false,
          query: scrydexCountQuery({
            environment: "test",
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
            parentValue,
          }),
        });
      }
    }
    const send = vi.fn(async (query: CountTarget["query"]) => ({
      totalCount: query.kind === "cards" ? 121 : 7,
      pageSize: 100,
      returnedPage: 1 as const,
      returnedItemCount: query.kind === "cards" ? 100 : 7,
      observedAt: now,
    }));
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
      send,
      allowed: () => true,
      now: () => now,
    });
    const quote = await engine.quote({ selection, owner: "synthetic-owner" });
    expect(
      (await engine.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "synthetic-owner" }))
        .state,
    ).toBe("complete");
    expect(await store.history()).toHaveLength(4);
    send.mockClear();
    let usageMode: "checked" | "failed" = "checked";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (!String(input).includes("/account/v1/usage"))
        throw new Error("Unexpected synthetic count/sealed provider call");
      return usageMode === "failed"
        ? Response.json({ error: "synthetic-denial" }, { status: 403 })
        : Response.json({
            data: {
              credits_remaining: 100,
              total_credits_consumed: 0,
              overage_credits_consumed: 0,
              period_start: "2026-01-01T00:00:00Z",
              period_end: "2027-01-01T00:00:00Z",
            },
          });
    });
    const cache = createPgCatalogProviderOptionQueryCacheStore(pools.catalog)!;
    const write = vi.spyOn(cache, "write");
    const enqueue = vi.fn();
    const adapterOptions = {
      fetch,
      credentials: { apiKey: "synthetic", teamId: "synthetic" },
      baseUrl: "https://synthetic.fixture.local/onepiece/v1",
      now: () => new Date(now),
      profileVersions: profiles,
      cacheStore: cache,
      countReader: store,
      countEnvironment: "test",
      countAccountRevision: "synthetic-revision",
    };
    const counts = createScopeSyncCountRuntime({
      pool: pools.catalog,
      store,
      environment: "test",
      accountRevision: "synthetic-revision",
      profiles,
      adapterOptions,
      now: () => now,
    });
    const runtime = createScopeSyncBatchRuntime({
      db: pools.catalog,
      counts,
      now: () => now,
      enqueueCatalogSyncRun: enqueue,
      getCatalogSyncRun: vi.fn(),
      cancelIntegrationJob: vi.fn(),
      previewCatalogSyncScope: async (input) =>
        previewCatalogSyncProviderParticipation({
          ...input,
          acceptedScopeMappings: input.acceptedScopeMappings ?? [],
          providerProfileVersions: await profiles.listProfileVersions(),
          providerAdapterRegistry: new ProviderAdapterRegistry([createScrydexOnePieceProviderAdapter(adapterOptions)]),
        }),
    });
    const countHistory = async () =>
      (await pools.catalog.query("SELECT * FROM catalog_scope_sync_count_history ORDER BY position")).rows;
    let expectedCountHistory = await countHistory();
    async function captureCountHistory() {
      expectedCountHistory = await countHistory();
    }
    async function noEffects(historyLength = 4) {
      expect((await pools.catalog.query("SELECT batch_id FROM catalog_scope_sync_batches")).rows).toHaveLength(0);
      expect((await pools.catalog.query("SELECT batch_id FROM catalog_scope_sync_batch_units")).rows).toHaveLength(0);
      expect(
        (await pools.catalog.query("SELECT event_id FROM catalog_scope_sync_count_history WHERE event_kind='debit'"))
          .rows,
      ).toHaveLength(historyLength);
      expect(await countHistory()).toEqual(expectedCountHistory);
      expect(enqueue).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(fetch.mock.calls.every(([url]) => String(url).includes("/account/v1/usage"))).toBe(true);
    }
    async function poisonSealed(transform: (evidence: Record<string, unknown>) => unknown) {
      const target = targets.find((entry) => entry.query.kind === "sealed")!;
      const result = await pools.catalog.query<{ event_id: string; payload: { evidence: Record<string, unknown> } }>(
        "SELECT event_id,payload FROM catalog_scope_sync_count_history WHERE event_kind='result' AND query_key=$1",
        [countQueryKey(target.query)],
      );
      await pools.catalog.query("UPDATE catalog_scope_sync_count_history SET payload=$2::jsonb WHERE event_id=$1", [
        result.rows[0]!.event_id,
        JSON.stringify({ outcome: "complete", evidence: transform(result.rows[0]!.payload.evidence) }),
      ]);
      await captureCountHistory();
    }
    return {
      runtime,
      fetch,
      enqueue,
      send,
      write,
      noEffects,
      poisonSealed,
      counts,
      captureCountHistory,
      setUsage: (value: "checked" | "unchecked" | "failed") => {
        adapterOptions.credentials.apiKey = value === "unchecked" ? "" : "synthetic";
        usageMode = value === "failed" ? "failed" : "checked";
      },
    };
  }
  it("AC1 fresh card and sealed governed counts preview ready and real confirm persists one batch/all scope units", async () => {
    const f = await fixture();
    const preview = await f.runtime.preview({ selection, budget, context });
    expect(preview).toMatchObject({
      status: "ready",
      confirmAllowed: true,
      providerRequestEstimates: { scrydex: 6 },
      counts: { scopes: 2, providerUnits: 4 },
    });
    await f.noEffects();
    const batch = await f.runtime.confirm({ selection, budget, context, planFingerprint: preview.planFingerprint });
    expect(batch.status).toBe("queued");
    expect(batch.units.map((unit) => unit.scopeRecordId)).toEqual(selection.scopeRecordIds);
    expect((await pools.catalog.query("SELECT batch_id FROM catalog_scope_sync_batches")).rows).toHaveLength(1);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(["missing", "stale", "future", "invalid", "wrong-query", "wrong-source"] as const)(
    "AC3 %s sealed evidence closes real direct confirm with mixed null sums and zero effects",
    async (mode) => {
      const f = await fixture();
      if (mode === "missing")
        await pools.catalog.query(
          "DELETE FROM catalog_scope_sync_count_history WHERE count_kind='sealed' OR (event_kind='result' AND payload->'evidence'->'query'->>'kind'='sealed')",
        );
      else
        await f.poisonSealed((evidence) => ({
          ...evidence,
          ...(mode === "stale" ? { observedAt: new Date(Date.parse(now) - 900_001).toISOString() } : {}),
          ...(mode === "future" ? { observedAt: new Date(Date.parse(now) + 1).toISOString() } : {}),
          ...(mode === "invalid" ? { returnedItemCount: 6 } : {}),
          ...(mode === "wrong-query" ? { query: { ...(evidence.query as object), parentValue: "wrong" } } : {}),
          ...(mode === "wrong-source" ? { sourceId: "synthetic-forged-debit" } : {}),
        }));
      await f.captureCountHistory();
      const preview = await f.runtime.preview({ selection, budget, context });
      expect(preview.status).toBe("blocked");
      expect(preview.providerRequestEstimates.scrydex).toBeNull();
      expect(preview.blockers.map((item) => item.code)).toContain("credited-provider-estimate-unavailable");
      await expect(
        f.runtime.confirm({ selection, budget, context, planFingerprint: preview.planFingerprint }),
      ).rejects.toThrow("blocked");
      await f.noEffects(mode === "missing" ? 2 : 4);
    },
  );
  it("AC3 accepted setName fallback keeps planning ready when set_id is cleared", async () => {
    const f = await fixture();
    await pools.catalog.query("UPDATE catalog_provider_scope_mappings SET set_id=NULL WHERE unit_key=$1", [sealedUnit]);
    const preview = await f.runtime.preview({ selection, budget, context });
    expect(preview.status).toBe("ready");
    expect(preview.providerRequestEstimates.scrydex).toBe(6);
    expect(preview.blockers).toEqual([]);
    await f.noEffects();
  });

  it("AC3 missing set_id and accepted setName remains scope-planning-blocked", async () => {
    const f = await fixture();
    await pools.catalog.query(
      "UPDATE catalog_provider_scope_mappings SET set_id=NULL,set_name=NULL WHERE unit_key=$1",
      [sealedUnit],
    );
    const preview = await f.runtime.preview({ selection, budget, context });
    expect(preview.status).toBe("blocked");
    expect(preview.blockers.map((item) => item.code)).toContain("scope-planning-blocked");
    await expect(
      f.runtime.confirm({ selection, budget, context, planFingerprint: preview.planFingerprint }),
    ).rejects.toThrow();
    await f.noEffects();
  });

  it.each(["unchecked", "failed", "budget"] as const)(
    "AC3 %s refusal remains distinct and cannot write/enqueue",
    async (mode) => {
      const f = await fixture();
      if (mode === "unchecked" || mode === "failed") f.setUsage(mode);
      const limits = mode === "budget" ? { creditedProviderRequestLimits: { scrydex: 5 } } : budget;
      const preview = await f.runtime.preview({ selection, budget: limits, context });
      expect(preview.status).toBe("blocked");
      expect(preview.blockers.map((item) => item.code)).toContain(
        mode === "budget"
          ? "credited-provider-budget-exceeded"
          : "credited-provider-estimate-unavailable",
      );
      if (mode === "unchecked") {
        expect(preview.blockers).toContainEqual(
          expect.objectContaining({
            code: "credited-provider-estimate-unavailable",
            scopeRecordId: selection.scopeRecordIds[0],
            message: t("catalog.features.scopeSyncBatches.api.planner.scrydex.credit.readiness.not.checked"),
          }),
        );
        expect(f.fetch).not.toHaveBeenCalled();
        expect(preview.blockers.some((item) => item.message.includes("lower"))).toBe(false);
      }
      await expect(
        f.runtime.confirm({ selection, budget: limits, context, planFingerprint: preview.planFingerprint }),
      ).rejects.toThrow();
      await f.noEffects();
    },
  );
  it.each(["expiry", "count", "mapping", "profile", "budget"] as const)(
    "AC4 confirm re-resolves %s authority and refuses the old fingerprint without effects",
    async (mode) => {
      const f = await fixture();
      const preview = await f.runtime.preview({ selection, budget, context });
      expect(preview.status).toBe("ready");
      let confirmBudget: Partial<ScopeSyncBatchBudget> = budget;
      if (mode === "expiry") now = new Date(Date.parse(now) + 900_001).toISOString();
      if (mode === "count") await f.poisonSealed((evidence) => ({ ...evidence, totalCount: 8, returnedItemCount: 8 }));
      if (mode === "mapping")
        await pools.catalog.query(
          "UPDATE catalog_provider_scope_mappings SET set_id='synthetic-new',updated_at=updated_at+interval '1 second' WHERE unit_key=$1",
          [sealedUnit],
        );
      if (mode === "profile")
        await pools.catalog.query(
          "UPDATE catalog_provider_integration_profile_versions SET active=false,lifecycle='test' WHERE profile_key='one-piece-sealed-product-source-observation'",
        );
      if (mode === "budget") confirmBudget = { creditedProviderRequestLimits: { scrydex: 5 } };
      await expect(
        f.runtime.confirm({ selection, budget: confirmBudget, context, planFingerprint: preview.planFingerprint }),
      ).rejects.toThrow("changed after preview");
      await f.noEffects();
    },
  );
  it("AC4 sealed authority changed after re-plan refuses reservation with cards unchanged", async () => {
    const f = await fixture();
    const preview = await f.runtime.preview({ selection, budget, context });
    expect(preview.status).toBe("ready");
    const reserve = f.counts.reserveBatch;
    vi.spyOn(f.counts, "reserveBatch").mockImplementation(async (input) => {
      await f.poisonSealed((evidence) => ({ ...evidence, sourceId: "synthetic-forged-debit" }));
      return reserve(input);
    });
    await expect(
      f.runtime.confirm({ selection, budget, context, planFingerprint: preview.planFingerprint }),
    ).rejects.toThrow("Count acquisition is blocked");
    await f.noEffects();
  });
});
