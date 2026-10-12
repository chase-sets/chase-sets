import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createCatalogProviderIntegrationProfileVersionStore } from "../../source-observations/api/providers/provider-integration-profile-store";
import { createPgCatalogProviderOptionQueryCacheStore } from "../../source-observations/api/providers/provider-option-query-cache";
import {
  scrydexCountQuery,
  createScrydexOnePieceProviderAdapter,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY as unitKey,
} from "../../source-observations/api/providers/scrydex/adapter";
import { countFingerprint } from "../domain/count-acquisition";
import { createScopeSyncBatchRuntime } from "./runtime";
import { previewCatalogSyncProviderParticipation } from "../../source-observations/api/catalog-sync-scope-planner";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import type { ProviderUsageSnapshot } from "../../source-observations/api/provider-adapters/provider-adapter";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { catalogCountHistorySchemaMigrations } from "../read-model/count-schema";

const base = process.env.TEST_DATABASE_URL;
if (!base && process.env.CI) throw new Error("TEST_DATABASE_URL is required for count acquisition DB proof.");
const describeDb = base ? describe : describe.skip;
describeDb("AC2/AC4 count acquisition durable caps and replica claims", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;
  let now: string;
  const slot = countAccountSlot("test", "runtime");
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic",
    audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
  };
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["catalog"], "scrydex_count_acquisition");
    await ensureMultiContextTestDatabases(base!, urls);
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
  async function setup(remaining = 2, pool = pools.catalog) {
    const store = createCountStore(pool, slot, () => now);
    await store.retainUsage({
      remainingCredits: remaining,
      totalCredits: remaining,
      observedAt: now,
      attemptState: "checked",
    } as ProviderUsageSnapshot);
    const query = scrydexCountQuery({
      environment: "test",
      accountRevision: "runtime",
      productDomain: "one-piece",
      profileKey: "one-piece-card-print-source-observation",
      profileVersion: "2026.06.22",
      unitKey,
      kind: "cards",
      languageCode: "en",
      parentValue: "OP01",
    });
    const send = vi.fn(async () => ({
      totalCount: 121,
      pageSize: 100,
      returnedPage: 1 as const,
      returnedItemCount: 100,
      observedAt: now,
    }));
    const engine = createCountAcquisition({
      ledger: {
        ...store,
        approve: (id, fingerprint, owner) => store.approve(pool, id, fingerprint, owner),
        claim: (quote, target, owner, authority) => store.claim(pool, quote, target, owner, authority),
      },
      resolve: async () => ({
        membershipFingerprint: "synthetic-membership",
        targets: [
          {
            scopeRecordId: "scope-synthetic",
            query,
            source: await store.read(query),
            blocked: await store.blocked(query),
          },
        ],
      }),
      send,
      allowed: () => true,
      now: () => now,
    });
    return { store, query, send, engine };
  }
  it.each([0, 1])("server cap %s is durable and cannot replay", async (cap) => {
    const f = await setup();
    const quote = await f.engine.quote({ selection: {}, owner: "synthetic", cap });
    await f.engine.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "synthetic" });
    await f.engine.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "synthetic" });
    expect(f.send).toHaveBeenCalledTimes(cap);
    expect(await f.store.history()).toHaveLength(cap);
  });
  it("different quotes/replicas racing one exact query commit one debit and send", async () => {
    const f = await setup(1);
    const replica = await setup(1);
    const a = await f.engine.quote({ selection: {}, owner: "synthetic" });
    const b = await replica.engine.quote({ selection: {}, owner: "synthetic" });
    await Promise.allSettled([
      f.engine.acquire({ quoteId: a.quoteId, fingerprint: a.fingerprint, owner: "synthetic" }),
      replica.engine.acquire({ quoteId: b.quoteId, fingerprint: b.fingerprint, owner: "synthetic" }),
    ]);
    expect(f.send.mock.calls.length + replica.send.mock.calls.length).toBe(1);
    expect(await f.store.history()).toHaveLength(1);
    const restart = await setup(1);
    expect((await restart.engine.quote({ selection: {}, owner: "synthetic" })).plannedCredits).toBe(0);
  });
  it("different exact queries cannot race shared account headroom or replenish from lag", async () => {
    const f = await setup(1);
    const a = await f.engine.quote({ selection: {}, owner: "synthetic" });
    const { fingerprint: _fingerprint, ...value } = a;
    const bValue = {
      ...value,
      quoteId: crypto.randomUUID(),
      targets: [{ ...a.targets[0]!, query: scrydexCountQuery({ ...f.query, parentValue: "OP02" }) }],
    };
    const b = { ...bValue, fingerprint: countFingerprint(bValue) };
    await f.store.saveQuote(b, "synthetic");
    await f.store.approve(pools.catalog, a.quoteId, a.fingerprint, "synthetic");
    await f.store.approve(pools.catalog, b.quoteId, b.fingerprint, "synthetic");
    const results = await Promise.allSettled([
      f.store.claim(pools.catalog, a, a.targets[0]!, "synthetic", a.authority),
      f.store.claim(pools.catalog, b, b.targets[0]!, "synthetic", b.authority),
    ]);
    expect(results.filter((result) => result.status === "fulfilled" && result.value)).toHaveLength(1);
    await f.store.retainUsage({
      remainingCredits: 1,
      totalCredits: 1,
      observedAt: now,
      attemptState: "checked",
    } as ProviderUsageSnapshot);
    expect((await f.store.authority()).headroom).toBe(0);
  });
  it("lost debit COMMIT acknowledgement sends nothing and cannot re-arm after TTL", async () => {
    let loseCommit = false;
    const pool: PgTransactionalPool = {
      query: pools.catalog.query.bind(pools.catalog),
      connect: async () => {
        const client = await pools.catalog.connect();
        return {
          release: client.release.bind(client),
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            const value = await client.query<Row>(sql, values);
            if (sql === "COMMIT" && loseCommit) {
              loseCommit = false;
              throw new Error("synthetic lost COMMIT acknowledgement");
            }
            return value;
          },
        };
      },
    };
    const f = await setup(2, pool);
    const quote = await f.engine.quote({ selection: {}, owner: "synthetic" });
    await f.store.approve(pool, quote.quoteId, quote.fingerprint, "synthetic");
    loseCommit = true;
    await expect(f.store.claim(pool, quote, quote.targets[0]!, "synthetic", quote.authority)).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.store.history())[0]?.outcome).toBe("uncertain");
    now = new Date(Date.parse(now) + 901_000).toISOString();
    expect(await f.store.blocked(f.query)).toBe(true);
  });
  it("additive upgrade is idempotent and preserves failed/expired debits", async () => {
    const f = await setup();
    const quote = await f.engine.quote({ selection: {}, owner: "synthetic" });
    await f.store.approve(pools.catalog, quote.quoteId, quote.fingerprint, "synthetic");
    const debit = await f.store.claim(pools.catalog, quote, quote.targets[0]!, "synthetic", quote.authority);
    await f.store.result(debit!, quote.quoteId, f.query, "failed", null);
    for (const migration of catalogCountHistorySchemaMigrations)
      for (const sql of migration.statements) await pools.catalog.query(sql);
    expect((await f.store.history())[0]?.outcome).toBe("failed");
    expect((await f.store.retainedQuote(quote)).state).toBe("failed");
    now = new Date(Date.parse(now) + 901_000).toISOString();
    expect(await f.store.history()).toHaveLength(1);
  });
  it.each([
    ["completed", 30 * 60 * 1000 + 1, 3],
    ["completed", 30 * 60 * 1000, 3],
    ["completed", 30 * 60 * 1000 - 1, 1],
    ["running", 31 * 60 * 1000, 1],
    ["queued", 31 * 60 * 1000, 1],
  ])("%s batch updated %s ms before usage leaves headroom %s", async (status, age, headroom) => {
    const f = await setup(3);
    await pools.catalog.query(
      `INSERT INTO catalog_scope_sync_batches (batch_id, selection,budget,plan_fingerprint,preview,status,event_context,updated_at)
      VALUES ('synthetic-old','{}','{"creditedProviderRequestLimits":{"scrydex":2}}','synthetic','{}',$1,'{}',$2::timestamptz)`,
      [status, new Date(Date.parse(now) - age).toISOString()],
    );
    expect((await f.store.authority()).headroom).toBe(headroom);
  });
  it("settled count spend ages into provider usage without double-debiting or ratcheting headroom", async () => {
    const f = await setup(3);
    const quote = await f.engine.quote({ selection: {}, owner: "synthetic" });
    await f.engine.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "synthetic" });
    expect((await f.store.authority()).headroom).toBe(2);
    now = new Date(Date.parse(now) + 30 * 60 * 1000).toISOString();
    await f.store.retainUsage({
      remainingCredits: 2,
      totalCredits: 3,
      observedAt: now,
      attemptState: "checked",
    } as ProviderUsageSnapshot);
    expect((await f.store.authority()).headroom).toBe(2);
    const next = await f.engine.quote({ selection: {}, owner: "synthetic" });
    await f.engine.acquire({ quoteId: next.quoteId, fingerprint: next.fingerprint, owner: "synthetic" });
    expect((await f.store.authority()).headroom).toBe(1);
    now = new Date(Date.parse(now) + 30 * 60 * 1000 + 1).toISOString();
    await f.store.retainUsage({
      remainingCredits: 1,
      totalCredits: 3,
      observedAt: now,
      attemptState: "checked",
    } as ProviderUsageSnapshot);
    expect((await f.store.authority()).headroom).toBe(1);
    expect(await f.store.history()).toHaveLength(2);
  });
  it("database-ahead clock skew cannot hide or extend a debit stamped by the store clock", async () => {
    const dbTime = await pools.catalog.query<{ now: Date }>("SELECT now() AS now");
    now = new Date(dbTime.rows[0]!.now.getTime() - 5 * 60 * 1000).toISOString();
    const f = await setup();
    const quote = await f.engine.quote({ selection: {}, owner: "synthetic" });
    await f.engine.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "synthetic" });
    expect(await f.store.history()).toMatchObject([{ debitedAt: now, outcome: "complete" }]);
    expect(await f.store.blocked(f.query)).toBe(true);
    now = new Date(Date.parse(now) + 901_000).toISOString();
    expect(await f.store.blocked(f.query)).toBe(false);
    expect(await f.store.history()).toHaveLength(1);
  });
  it("closed invalid and stale usage keeps headroom unavailable", async () => {
    const f = await setup(3);
    now = new Date(Date.parse(now) + 901_000).toISOString();
    expect((await f.store.authority()).headroom).toBeNull();
    await f.store.retainUsage({
      remainingCredits: -1,
      totalCredits: 3,
      observedAt: now,
      attemptState: "checked",
    } as ProviderUsageSnapshot);
    expect((await f.store.authority()).headroom).toBeNull();
  });
  it.each(["fresh", "stale"])(
    "AC4/AC5 real planner with %s count keeps confirm independent of count headroom",
    async (freshness) => {
      const f = await setup(10);
      const profiles = createCatalogProviderIntegrationProfileVersionStore(pools.catalog);
      await profiles.seedProfileVersions();
      await pools.catalog.query(
        `INSERT INTO catalog_scope_records (scope_record_id,product_domain,scope_kind,reference_type_key,reference_record_id,reference_record_key,name,lifecycle_status) VALUES ('scope-synthetic','one-piece','set','one-piece-set','ref-synthetic','OP01','Synthetic','active')`,
      );
      await pools.catalog.query(
        `INSERT INTO catalog_provider_scope_mappings (mapping_id,scope_record_id,provider_key,unit_key,set_id,set_name,confidence,review_status,policy_version) VALUES ('mapping-synthetic','scope-synthetic','scrydex',$1,'OP01','Synthetic Set','exact','accepted','synthetic')`,
        [unitKey],
      );
      // Derived envelope from c6127099375; card items below are synthetic and never cached as complete.
      const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
        new URL(String(input)).pathname.endsWith("/usage")
          ? Response.json({
              data: {
                credits_remaining: 100,
                total_credits_consumed: 0,
                overage_credits_consumed: 0,
                period_start: "2026-01-01T00:00:00Z",
                period_end: "2027-01-01T00:00:00Z",
              },
            })
          : Response.json({
              count: 100,
              data: Array.from({ length: 100 }, () => ({})),
              page: 1,
              page_size: 100,
              total_count: 121,
            }),
      );
      const options = {
        fetch,
        baseUrl: "http://127.0.0.1/onepiece/v1",
        credentials: { apiKey: "synthetic", teamId: "synthetic" },
        now: () => new Date(now),
        profileVersions: profiles,
        countReader: f.store,
        countEnvironment: "test",
        countAccountRevision: "runtime",
        cacheStore: createPgCatalogProviderOptionQueryCacheStore(pools.catalog),
      };
      const counts = createScopeSyncCountRuntime({
        pool: pools.catalog,
        store: f.store,
        environment: "test",
        accountRevision: "runtime",
        profiles,
        adapterOptions: options,
        now: () => now,
      });
      const selection = { mode: "ids" as const, scopeRecordIds: ["scope-synthetic"] };
      const quote = await counts.quoteCounts({ selection, context });
      expect(fetch).not.toHaveBeenCalled();
      expect(quote.plannedCredits).toBe(1);
      expect(
        (await counts.acquireCounts({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, context })).state,
      ).toBe("complete");
      expect(fetch).toHaveBeenCalledOnce();
      await pools.catalog.query("DELETE FROM catalog_scope_sync_count_history WHERE event_kind='usage'");
      await pools.catalog.query(
        `INSERT INTO catalog_scope_sync_batches (batch_id,selection,budget,plan_fingerprint,preview,status,event_context,updated_at)
      VALUES ('synthetic-old','{}','{"creditedProviderRequestLimits":{"scrydex":100}}','synthetic','{}','completed','{}',$1::timestamptz)`,
        [new Date(Date.parse(now) - 31 * 60 * 1000).toISOString()],
      );
      expect((await f.store.authority()).headroom).toBeNull();
      const adapter = createScrydexOnePieceProviderAdapter(options);
      const enqueue = vi.fn();
      const runtime = createScopeSyncBatchRuntime({
        db: pools.catalog,
        now: () => now,
        counts,
        enqueueCatalogSyncRun: enqueue,
        getCatalogSyncRun: vi.fn(),
        cancelIntegrationJob: vi.fn(),
        previewCatalogSyncScope: async (input) =>
          previewCatalogSyncProviderParticipation({
            ...input,
            acceptedScopeMappings: input.acceptedScopeMappings ?? [],
            providerProfileVersions: await profiles.listProfileVersions(),
            providerAdapterRegistry: new ProviderAdapterRegistry([adapter]),
          }),
      });
      const preview = await runtime.preview({
        selection,
        budget: { creditedProviderRequestLimits: { scrydex: 10 } },
        context,
      });
      expect(preview.providerRequestEstimates.scrydex).toBe(2);
      expect(preview.blockers).toEqual([]);
      if (freshness === "stale") {
        now = new Date(Date.parse(now) + 901_000).toISOString();
        await f.store.retainUsage({
          remainingCredits: 100,
          totalCredits: 100,
          observedAt: now,
          attemptState: "checked",
        } as ProviderUsageSnapshot);
        expect((await f.store.authority()).allowed).toBe(true);
        await expect(
          runtime.confirm({ selection, budget: preview.budget, planFingerprint: preview.planFingerprint, context }),
        ).rejects.toThrow();
      } else {
        const batch = await runtime.confirm({
          selection,
          budget: preview.budget,
          planFingerprint: preview.planFingerprint,
          context,
        });
        expect(batch.status).toBe("queued");
        expect(batch.units).toHaveLength(1);
      }
      expect(fetch.mock.calls.filter(([url]) => !String(url).includes("/usage"))).toHaveLength(1);
      expect(
        (await pools.catalog.query("SELECT batch_id FROM catalog_scope_sync_batches WHERE batch_id <> 'synthetic-old'"))
          .rows,
      ).toHaveLength(freshness === "fresh" ? 1 : 0);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
});
