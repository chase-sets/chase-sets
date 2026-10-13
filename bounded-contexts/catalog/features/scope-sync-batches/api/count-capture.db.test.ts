import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { createCountStore, countAccountSlot } from "../read-model/count-store";
import { createCountAcquisition } from "./count-acquisition";
import { createScopeSyncCountRuntime } from "./count-runtime";
import { createScopeSyncBatchRuntime } from "./runtime";
import { collectCountCapturePlannerRead } from "./count-capture-context";
import { createCatalogProviderIntegrationProfileVersionStore } from "../../source-observations/api/providers/provider-integration-profile-store";
import { createPgCatalogProviderOptionQueryCacheStore } from "../../source-observations/api/providers/provider-option-query-cache";
import {
  createScrydexOnePieceProviderAdapter,
  scrydexCountQuery,
} from "../../source-observations/api/providers/scrydex/adapter";
import { previewCatalogSyncProviderParticipation } from "../../source-observations/api/catalog-sync-scope-planner";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import type { CountTarget } from "../domain/count-acquisition";

const base = process.env.TEST_DATABASE_URL;
if (!base && process.env.CI) throw new Error("TEST_DATABASE_URL is required for count capture DB proof.");
const describeDb = base ? describe : describe.skip;

describeDb("pre-confirm has no effect capability", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic_9520",
    audit: { performedByUserId: "usr_synthetic_9520", forAccountId: "acc_synthetic_9520" },
  };
  const selection = { mode: "ids" as const, scopeRecordIds: ["scope-synthetic-9520"] };
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["catalog"], "count_capture_9520");
    await ensureMultiContextTestDatabases(base!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(catalogModule.schemaSql);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("uses the real adapter/planner/DB and allows real confirm only outside the observation", async () => {
    const now = new Date().toISOString();
    const profiles = createCatalogProviderIntegrationProfileVersionStore(pools.catalog);
    await profiles.seedProfileVersions();
    const store = createCountStore(pools.catalog, countAccountSlot("test", "synthetic-9520"), () => now);
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
    await pools.catalog.query(
      `INSERT INTO catalog_scope_records
      (scope_record_id,product_domain,scope_kind,reference_type_key,reference_record_id,reference_record_key,name,lifecycle_status)
      VALUES ($1,'one-piece','set','one-piece-set','ref-synthetic-9520','OP01','Synthetic Romance Dawn','active')`,
      [selection.scopeRecordIds[0]],
    );
    const targets: CountTarget[] = [];
    for (const kind of ["cards", "sealed"] as const) {
      const unitKey = `scrydex:one-piece:${kind === "cards" ? "single-card" : "sealed-product"}:source-observation-import`;
      await pools.catalog.query(
        `INSERT INTO catalog_provider_scope_mappings
        (mapping_id,scope_record_id,provider_key,unit_key,set_id,set_name,confidence,review_status,policy_version)
        VALUES ($1,$2,'scrydex',$3,'OP01','Synthetic Romance Dawn','exact','accepted','synthetic')`,
        [`mapping-synthetic-${kind}`, selection.scopeRecordIds[0], unitKey],
      );
      targets.push({
        scopeRecordId: selection.scopeRecordIds[0]!,
        blocked: false,
        source: null,
        query: scrydexCountQuery({
          environment: "test",
          accountRevision: "synthetic-9520",
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
    const acquisition = createCountAcquisition({
      ledger: {
        ...store,
        approve: (id, fingerprint, owner) => store.approve(pools.catalog, id, fingerprint, owner),
        claim: (quote, target, owner, authority) => store.claim(pools.catalog, quote, target, owner, authority),
      },
      resolve: async () => ({ membershipFingerprint: "synthetic-membership", targets }),
      send: async (query) => ({
        totalCount: query.kind === "cards" ? 121 : 7,
        pageSize: 100,
        returnedPage: 1,
        returnedItemCount: query.kind === "cards" ? 100 : 7,
        observedAt: now,
      }),
      allowed: () => true,
      now: () => now,
    });
    const quote = await acquisition.quote({ selection, owner: "synthetic-writer-owner" });
    expect(
      (
        await acquisition.acquire({
          quoteId: quote.quoteId,
          fingerprint: quote.fingerprint,
          owner: "synthetic-writer-owner",
        })
      ).state,
    ).toBe("complete");
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (new URL(String(input)).pathname !== "/account/v1/usage")
        throw new Error("Unexpected synthetic provider path.");
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
      credentials: { apiKey: "synthetic-only", teamId: "synthetic-only" },
      baseUrl: "http://127.0.0.1/onepiece/v1",
      now: () => new Date(now),
      profileVersions: profiles,
      cacheStore: createPgCatalogProviderOptionQueryCacheStore(pools.catalog),
      countReader: store,
      countEnvironment: "test",
      countAccountRevision: "synthetic-9520",
    };
    const adapter = createScrydexOnePieceProviderAdapter(adapterOptions);
    const counts = createScopeSyncCountRuntime({
      pool: pools.catalog,
      store,
      environment: "test",
      accountRevision: "synthetic-9520",
      profiles,
      adapterOptions,
      now: () => now,
    });
    const enqueue = vi.fn(async () => {
      throw new Error("enqueue trap");
    });
    const reserve = vi.fn(async () => {
      throw new Error("reserve trap");
    });
    const dependencies = {
      db: pools.catalog,
      now: () => now,
      enqueueCatalogSyncRun: enqueue,
      getCatalogSyncRun: vi.fn(),
      cancelIntegrationJob: vi.fn(),
    };
    const previewCatalogSyncScope: Parameters<
      typeof createScopeSyncBatchRuntime
    >[0]["previewCatalogSyncScope"] = async (input) =>
      previewCatalogSyncProviderParticipation({
        ...input,
        acceptedScopeMappings: input.acceptedScopeMappings ?? [],
        providerProfileVersions: await profiles.listProfileVersions(),
        providerAdapterRegistry: new ProviderAdapterRegistry([adapter]),
      });
    const observed = createScopeSyncBatchRuntime({
      ...dependencies,
      previewCatalogSyncScope,
      counts: { ...counts, reserveBatch: reserve },
    });
    const input = { selection, budget: { creditedProviderRequestLimits: { scrydex: 10 } }, context };
    const previewObservation = await collectCountCapturePlannerRead(() => observed.preview(input));
    const preview = previewObservation.value;
    expect(previewObservation.plan.preview).toEqual(preview);
    expect(previewObservation.winners.map((winner) => winner.source?.query.kind).sort()).toEqual(["cards", "sealed"]);
    expect(preview.confirmAllowed).toBe(true);
    const queries = vi.spyOn(pools.catalog, "query");
    const observation = await collectCountCapturePlannerRead(() =>
      observed.preConfirmPlannerRead({ ...input, planFingerprint: preview.planFingerprint }),
    );
    expect(observation.value.eligible).toBe(true);
    expect(observation.value.effectsCapability).toBe(false);
    expect(observation.value.currentFingerprint).toBe(preview.planFingerprint);
    expect(observation.plan).toEqual(observation.value.current);
    expect(observation.winners.map((winner) => winner.source?.query.kind).sort()).toEqual(["cards", "sealed"]);
    expect(reserve).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(
      queries.mock.calls.some(([sql]) => /catalog_scope_sync_batches|INSERT|UPDATE|DELETE/i.test(String(sql))),
    ).toBe(false);
    queries.mockRestore();
    const oracle = createScopeSyncBatchRuntime({ ...dependencies, previewCatalogSyncScope, counts });
    expect((await oracle.confirm({ ...input, planFingerprint: preview.planFingerprint })).status).toBe("queued");
    expect(enqueue).not.toHaveBeenCalled();
    expect(
      (await pools.catalog.query<{ count: string }>("SELECT count(*) FROM catalog_scope_sync_batches")).rows[0]?.count,
    ).toBe("1");
  });
});
