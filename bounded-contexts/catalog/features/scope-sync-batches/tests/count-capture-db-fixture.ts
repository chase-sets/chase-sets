import { vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { previewCatalogSyncProviderParticipation } from "../../source-observations/api/catalog-sync-scope-planner";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import { createCatalogProviderIntegrationProfileVersionStore } from "../../source-observations/api/providers/provider-integration-profile-store";
import { createPgCatalogProviderOptionQueryCacheStore } from "../../source-observations/api/providers/provider-option-query-cache";
import { createScrydexOnePieceProviderAdapter } from "../../source-observations/api/providers/scrydex/adapter";
import { countCaptureUnitKeys } from "../domain/count-capture-plan";
import { countAccountSlot, createCountStore } from "../read-model/count-store";
import { createCountCaptureStore, readCountCaptureEffects } from "../read-model/count-capture-store";
import { createScopeSyncCountRuntime } from "../api/count-runtime";
import { createScopeSyncBatchRuntime } from "../api/runtime";
import {
  createCountCaptureLifecycle,
  readCountCaptureEvidence,
  readCountCaptureRoster,
} from "../api/count-capture-lifecycle";
import { captureAt, captureScope, captureSession, captureAuthority } from "./count-capture-session-fixture";

// Real PostgreSQL, writer, adapter and planner; every HTTP call is this fake.
// Callers reset their isolated Catalog schema before creating this fixture.
export async function createCountCaptureDbFixture(pool: PgTransactionalPool) {
  await pool.query(catalogModule.schemaSql);
  const clock = { now: captureAt };
  const now = () => clock.now;
  const profiles = createCatalogProviderIntegrationProfileVersionStore(pool);
  await profiles.seedProfileVersions();
  await pool.query(
    `INSERT INTO catalog_scope_records (scope_record_id,product_domain,scope_kind,reference_type_key,reference_record_id,reference_record_key,name,lifecycle_status,updated_at)
    VALUES ($1,'one-piece','set','one-piece-set','ref-synthetic-op01','OP01','Synthetic Romance Dawn','active',$2)`,
    [captureScope, "2026-10-13T07:00:00.000Z"],
  );
  for (const [index, unitKey] of countCaptureUnitKeys.entries())
    await pool.query(
      `INSERT INTO catalog_provider_scope_mappings
    (mapping_id,scope_record_id,provider_key,unit_key,set_id,set_name,confidence,review_status,policy_version,updated_at)
    VALUES ($1,$2,'scrydex',$3,'OP01','Synthetic Romance Dawn','exact','accepted','synthetic',$4)`,
      [`mapping-synthetic-${index}`, captureScope, unitKey, "2026-10-13T07:00:00.000Z"],
    );
  const countStore = createCountStore(pool, countAccountSlot("staging", "runtime"), now);
  await countStore.retainUsage({
    providerKey: "scrydex",
    creditUnit: "credit",
    creditState: "available",
    remainingCredits: 100,
    totalCredits: 100,
    usedCredits: 0,
    observedAt: captureAt,
    attemptedAt: captureAt,
    attemptState: "checked",
    providerUpdatedAt: null,
    lagCategory: "documented-window",
    diagnosticCode: null,
    diagnostic: null,
    freshWithinSeconds: 900,
    unavailableAfterSeconds: 900,
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.scrydex.com") throw new Error("Unexpected synthetic provider origin.");
    if (url.pathname === "/account/v1/usage")
      return Response.json({
        data: {
          credits_remaining: 100,
          total_credits_consumed: 0,
          overage_credits_consumed: 0,
          period_start: "2026-01-01T00:00:00Z",
          period_end: "2027-01-01T00:00:00Z",
        },
      });
    const total = url.pathname.endsWith("/sealed") ? 7 : 121;
    if (url.searchParams.get("page") !== "1") throw new Error("Unexpected synthetic pagination.");
    return Response.json({
      count: Math.min(total, 100),
      data: Array.from({ length: Math.min(total, 100) }, () => ({})),
      page: 1,
      page_size: 100,
      total_count: total,
    });
  });
  const options = {
    fetch,
    credentials: { apiKey: "synthetic-key", teamId: "synthetic-team" },
    now: () => new Date(now()),
    profileVersions: profiles,
    cacheStore: createPgCatalogProviderOptionQueryCacheStore(pool),
    countReader: countStore,
    countEnvironment: "staging",
    countAccountRevision: "runtime",
  };
  const countRuntime = createScopeSyncCountRuntime({
    pool,
    store: countStore,
    environment: "staging",
    accountRevision: "runtime",
    profiles,
    adapterOptions: options,
    now,
  });
  const registry = new ProviderAdapterRegistry([createScrydexOnePieceProviderAdapter(options)]);
  const enqueue = vi.fn(async () => {
    throw new Error("enqueue trap");
  });
  const runtime = createScopeSyncBatchRuntime({
    db: pool,
    counts: countRuntime,
    now,
    enqueueCatalogSyncRun: enqueue,
    getCatalogSyncRun: vi.fn(),
    cancelIntegrationJob: vi.fn(),
    previewCatalogSyncScope: async (input) =>
      previewCatalogSyncProviderParticipation({
        ...input,
        acceptedScopeMappings: input.acceptedScopeMappings ?? [],
        providerProfileVersions: await profiles.listProfileVersions(),
        providerAdapterRegistry: registry,
      }),
  });
  const store = createCountCaptureStore(pool, now);
  const lifecycle = createCountCaptureLifecycle({
    environment: "staging",
    accountRevision: "runtime",
    store,
    counts: runtime,
    readRoster: (scopeRecordId) => readCountCaptureRoster(pool, profiles, scopeRecordId),
    readEffects: (at) => readCountCaptureEffects(pool, at),
    countAuthority: () => countStore.authority(),
    observeUsage: async () => {
      throw new Error("Unexpected bootstrap.");
    },
    readCountEvidence: (quote) => readCountCaptureEvidence(pool, countStore.slot, quote),
    now,
  });
  const selection = { mode: "ids" as const, scopeRecordIds: [captureScope] };
  const budget = { creditedProviderRequestLimits: { scrydex: 10 } };
  const prepare = async () => {
    await lifecycle.baseline(captureSession(), { scopeRecordId: captureScope, authority: captureAuthority() });
    await lifecycle.initialNotice(captureSession());
    await lifecycle.usage(captureSession());
    const quote = await lifecycle.quote(captureSession(), { selection, budget });
    await lifecycle.quoteReadback(captureSession());
    await lifecycle.finalNotice(captureSession());
    return quote;
  };
  return {
    pool,
    clock,
    lifecycle,
    store,
    countStore,
    countRuntime,
    runtime,
    fetch,
    enqueue,
    selection,
    budget,
    prepare,
  };
}
