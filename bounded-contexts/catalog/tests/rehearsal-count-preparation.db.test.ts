import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { module as catalogModule } from "../index";
import { countAccountSlot, createCountStore } from "../features/scope-sync-batches/read-model/count-store";
import { createScopeSyncCountRuntime } from "../features/scope-sync-batches/api/count-runtime";
import { createScopeSyncBatchRuntime } from "../features/scope-sync-batches/api/runtime";
import { scopeSyncBatchRoutes } from "../features/scope-sync-batches/api/route";
import {
  acquireRehearsalCounts,
  admitRehearsalCountAcquisition,
  createRehearsalCountAdminClient,
  quoteRehearsalCounts,
} from "../features/scope-sync-batches/api/rehearsal-count-preparation";
import {
  parseRehearsalCountPreparationPass,
  rehearsalCountPreparationApprovalSchemaVersion,
  validateRehearsalCountPreparationReceipt,
  type RehearsalCountPreparationReceipt,
} from "../features/scope-sync-batches/domain/rehearsal-count-preparation-receipt";
import { createCatalogProviderIntegrationProfileVersionStore } from "../features/source-observations/api/providers/provider-integration-profile-store";
import { createPgCatalogProviderOptionQueryCacheStore } from "../features/source-observations/api/providers/provider-option-query-cache";
import type { ProviderUsageSnapshot } from "../features/source-observations/api/provider-adapters/provider-adapter";

const base = process.env.TEST_DATABASE_URL;
if (!base && process.env.CI) throw new Error("TEST_DATABASE_URL is required for count preparation DB proof.");
const describeDb = base ? describe : describe.skip;

const origin = "http://127.0.0.1";
const run = { sha: "a".repeat(40), runId: "123456", runAttempt: "1" };
const context: EventStoreContext = {
  tenantId: "tnt_synthetic",
  audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
};
const actor: ResolvedActor = {
  roleKey: "platform-admin",
  permissions: ["catalog.manage", "catalog.view"],
  sessionId: "synthetic-session",
  tenantId: "tnt_synthetic",
  userId: "usr_synthetic",
  accountId: "acc_synthetic",
  membershipId: "synthetic-membership",
};
const scopes = [
  ["scope-op01", "one-piece", "OP01", ["single-card", "sealed-product"]],
  ["scope-op02", "one-piece", "OP02", ["single-card", "sealed-product"]],
  ["scope-lor01", "lorcana", "LOR1", ["single-card"]],
  ["scope-mtg01", "magic", "MTG1", []],
] as const;

describeDb("AC2/AC3 rehearsal count preparation over real Admin routes, writer and Postgres", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;
  let now: string;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["catalog"], "rehearsal_count_preparation");
    await ensureMultiContextTestDatabases(base!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(catalogModule.schemaSql);
    now = new Date().toISOString();
    for (const [scopeRecordId, productDomain, setId, units] of scopes) {
      await pools.catalog.query(
        `INSERT INTO catalog_scope_records (scope_record_id,product_domain,scope_kind,reference_type_key,reference_record_id,reference_record_key,name,lifecycle_status)
        VALUES ($1,$2,'set',$3,$4,$5,'Synthetic','active')`,
        [scopeRecordId, productDomain, `${productDomain}-set`, `ref-${scopeRecordId}`, setId],
      );
      for (const unit of units)
        await pools.catalog.query(
          `INSERT INTO catalog_provider_scope_mappings (mapping_id,scope_record_id,provider_key,unit_key,set_id,set_name,confidence,review_status,policy_version)
          VALUES ($1,$2,'scrydex',$3,$4,'Synthetic Set','exact','accepted','synthetic')`,
          [
            `mapping-${scopeRecordId}-${unit}`,
            scopeRecordId,
            `scrydex:${productDomain}:${unit}:source-observation-import`,
            setId,
          ],
        );
    }
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function setup(remaining = 40, providerFault?: (index: number) => Response | null) {
    const store = createCountStore(pools.catalog, countAccountSlot("test", "runtime"), () => now);
    await store.retainUsage({
      remainingCredits: remaining,
      totalCredits: remaining,
      observedAt: now,
      attemptState: "checked",
    } as ProviderUsageSnapshot);
    const profiles = createCatalogProviderIntegrationProfileVersionStore(pools.catalog);
    await profiles.seedProfileVersions();
    // Credential-free loopback provider: synthetic keys, a loopback base URL, page-1 count envelopes only.
    const sends: string[] = [];
    const usage: string[] = [];
    const provider = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname !== "127.0.0.1") throw new Error("loopback isolation: provider left loopback");
      if (url.pathname.endsWith("/usage")) {
        usage.push(url.pathname);
        throw new Error("usage refresh is outside preparation");
      }
      sends.push(`${url.pathname}?${url.searchParams.get("q") ?? ""}`);
      const fault = providerFault?.(sends.length);
      if (fault) return fault;
      const cards = url.pathname.endsWith("/cards");
      const total = cards ? 121 : 7;
      const length = Math.min(total, 100);
      return Response.json({
        count: length,
        data: Array.from({ length }, () => ({})),
        page: 1,
        page_size: 100,
        total_count: total,
      });
    });
    const counts = createScopeSyncCountRuntime({
      pool: pools.catalog,
      store,
      environment: "test",
      accountRevision: "runtime",
      profiles,
      adapterOptions: {
        fetch: provider,
        baseUrl: "http://127.0.0.1/onepiece/v1",
        credentials: { apiKey: "synthetic", teamId: "synthetic" },
        now: () => new Date(now),
        profileVersions: profiles,
        countReader: store,
        countEnvironment: "test",
        countAccountRevision: "runtime",
        cacheStore: createPgCatalogProviderOptionQueryCacheStore(pools.catalog),
      },
      now: () => now,
    });
    const batchTraps = {
      previewCatalogSyncScope: vi.fn(),
      enqueueCatalogSyncRun: vi.fn(),
      getCatalogSyncRun: vi.fn(),
      cancelIntegrationJob: vi.fn(),
    };
    const services = createScopeSyncBatchRuntime({ db: pools.catalog, counts, now: () => now, ...batchTraps });
    const root = new Hono<{ Variables: { context: EventStoreContext; actor: ResolvedActor | null } }>();
    root.use("*", async (c, next) => {
      c.set("context", context);
      c.set("actor", actor);
      await next();
    });
    root.route("/api/catalog/scope-sync-batches", scopeSyncBatchRoutes(services));
    const adminRequests: string[] = [];
    const admin = createRehearsalCountAdminClient({
      origin,
      cookie: "chase_sets_session=synthetic",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== origin) throw new Error("loopback isolation: Admin left loopback");
        adminRequests.push(`${init?.method ?? "GET"} ${url.pathname.replace(/[0-9a-f-]{36}$/, ":id")}`);
        return root.request(url.toString(), init);
      },
    });
    return { store, admin, sends, usage, adminRequests, batchTraps };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  const pass = (productDomain: string, passNumber = 1) =>
    parseRehearsalCountPreparationPass({ passNumber, productDomain, languageCode: "" });
  const dispatchId = (productDomain: string) => `9224-pass1-${productDomain}`;
  const expectValid = (receipt: RehearsalCountPreparationReceipt) =>
    expect(validateRehearsalCountPreparationReceipt(receipt, { ...run, forbiddenValues: [] }).errors).toEqual([]);

  async function quote(f: Setup, productDomain: string, cap?: number) {
    const receipt = await quoteRehearsalCounts({
      admin: f.admin,
      run,
      dispatchId: dispatchId(productDomain),
      pass: pass(productDomain),
      cap,
      now: () => now,
    });
    expectValid(receipt);
    return receipt;
  }
  function approval(receipt: RehearsalCountPreparationReceipt) {
    const q = receipt.quote!;
    return JSON.stringify({
      schemaVersion: rehearsalCountPreparationApprovalSchemaVersion,
      dispatchId: receipt.dispatchId,
      approvalId: "host-approval-1",
      approvedAt: now,
      pass: receipt.pass,
      quote: {
        quoteId: q.quoteId,
        fingerprint: q.fingerprint,
        membershipFingerprint: q.membershipFingerprint,
        expiresAt: q.expiresAt,
      },
      plannedCredits: q.plannedCredits,
      perKindCost: q.perKindCost,
      cap: q.cap,
      authority: { fingerprint: q.authority.fingerprint, headroom: q.authority.headroom, observedAt: now },
    });
  }
  async function acquire(f: Setup, quoted: RehearsalCountPreparationReceipt) {
    const admitted = admitRehearsalCountAcquisition({
      approval: approval(quoted),
      pass: quoted.pass,
      dispatchId: quoted.dispatchId,
      now,
    });
    const receipt = await acquireRehearsalCounts({ admin: f.admin, run, approval: admitted, now: () => now });
    expectValid(receipt);
    return receipt;
  }
  async function expectNoBatch(f: Setup) {
    for (const [name, trap] of Object.entries(f.batchTraps)) expect(trap, name).not.toHaveBeenCalled();
    expect((await pools.catalog.query("SELECT batch_id FROM catalog_scope_sync_batches")).rows).toEqual([]);
    expect(f.usage).toEqual([]);
  }
  const perSet = (sends: readonly string[]) =>
    Object.values(
      sends.reduce<Record<string, number>>((counts, send) => {
        const set = /OP0\d|LOR1/.exec(send)?.[0] ?? "unknown";
        counts[set] = (counts[set] ?? 0) + 1;
        return counts;
      }, {}),
    );

  it("prepares One Piece with <=1 call per kind and <=2 credits per set, then reuses at zero spend", async () => {
    const f = await setup();
    const quoted = await quote(f, "one-piece");
    expect(quoted).toMatchObject({ outcome: "quoted", quote: { plannedCredits: 4, cap: 4, scopeCount: 2 } });
    expect(f.sends).toEqual([]);
    const receipt = await acquire(f, quoted);
    expect(receipt.outcome).toBe("complete");
    expect(receipt.debits).toHaveLength(4);
    expect(f.sends).toHaveLength(4);
    expect(new Set(f.sends).size).toBe(4);
    expect(perSet(f.sends).every((count) => count <= 2)).toBe(true);
    expect(await f.store.history()).toHaveLength(4);
    expect(f.adminRequests).toEqual([
      "POST /api/catalog/scope-sync-batches/counts/quote",
      "GET /api/catalog/scope-sync-batches/counts/quote/:id",
      "POST /api/catalog/scope-sync-batches/counts/acquire",
      "GET /api/catalog/scope-sync-batches/counts/quote/:id",
    ]);

    const reused = await quote(f, "one-piece");
    expect(reused).toMatchObject({ outcome: "not-required", quote: { plannedCredits: 0 } });
    expect(reused.roster.every((entry) => entry.state === "reused")).toBe(true);
    expect(f.sends).toHaveLength(4);
    await expectNoBatch(f);
  });

  it("prepares Lorcana cards only and reports no-Scrydex domains as not-required", async () => {
    const f = await setup();
    const lorcana = await quote(f, "lorcana");
    expect(lorcana.roster.map((entry) => entry.kind)).toEqual(["cards"]);
    expect((await acquire(f, lorcana)).outcome).toBe("complete");
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatch(/\/cards\?/);
    const magic = await quote(f, "magic");
    expect(magic).toMatchObject({ outcome: "not-required", roster: [], quote: { plannedCredits: 0, targetCount: 0 } });
    expect(f.sends).toHaveLength(1);
    await expectNoBatch(f);
  });

  it("duplicate and concurrent invocations add no sends beyond one per kind", async () => {
    const f = await setup();
    const quoted = await quote(f, "one-piece");
    const results = await Promise.all([acquire(f, quoted), acquire(f, quoted)]);
    expect(results.some((receipt) => receipt.outcome === "complete")).toBe(true);
    expect(f.sends).toHaveLength(4);
    expect(await f.store.history()).toHaveLength(4);
    const replay = await acquire(f, quoted);
    expect(replay).toMatchObject({ outcome: "refused", refusal: "quote-not-pending" });
    expect(f.sends).toHaveLength(4);
    await expectNoBatch(f);
  });

  it("cap or headroom below P refuses before submission", async () => {
    const thin = await setup(3);
    expect(await quote(thin, "one-piece")).toMatchObject({ outcome: "refused", refusal: "headroom-below-planned" });
    const capped = await quote(thin, "one-piece", 1);
    expect(capped).toMatchObject({ outcome: "refused", refusal: "headroom-below-planned", quote: { cap: 1 } });
    const roomy = await setup(40);
    expect(await quote(roomy, "one-piece", 3)).toMatchObject({ outcome: "refused", refusal: "cap-below-planned" });
    for (const f of [thin, roomy]) {
      expect(f.sends).toEqual([]);
      expect(f.adminRequests.every((request) => request.endsWith("/counts/quote"))).toBe(true);
    }
    expect(await thin.store.history()).toEqual([]);
    await expectNoBatch(roomy);
  });

  it("refuses drift and stops partial failure with retained debits, no refund and no reacquire", async () => {
    const drift = await setup();
    const quoted = await quote(drift, "one-piece");
    await pools.catalog.query(
      `INSERT INTO catalog_scope_records (scope_record_id,product_domain,scope_kind,reference_type_key,reference_record_id,reference_record_key,name,lifecycle_status)
      VALUES ('scope-op03','one-piece','set','one-piece-set','ref-scope-op03','OP03','Synthetic','active')`,
    );
    const drifted = await acquire(drift, quoted);
    expect(drifted).toMatchObject({ outcome: "failed", acquisition: { response: { status: 409 } } });
    expect(drift.sends).toEqual([]);
    await pools.catalog.query("DELETE FROM catalog_scope_records WHERE scope_record_id='scope-op03'");

    const partial = await setup(40, (index) => (index === 2 ? new Response("{}", { status: 500 }) : null));
    const fresh = await quote(partial, "one-piece");
    const headroomBefore = (await partial.store.authority()).headroom!;
    const stopped = await acquire(partial, fresh);
    expect(stopped.outcome).toBe("failed");
    expect(stopped.acquisition?.readback.state).toBe("failed");
    expect(partial.sends).toHaveLength(2);
    expect((await partial.store.history()).map((spend) => spend.outcome).sort()).toEqual(["complete", "failed"]);
    expect(await acquire(partial, fresh)).toMatchObject({ outcome: "refused", refusal: "quote-not-pending" });
    expect(partial.sends).toHaveLength(2);
    expect((await partial.store.authority()).headroom).toBe(headroomBefore - 2);
    await expectNoBatch(partial);
  });
});
