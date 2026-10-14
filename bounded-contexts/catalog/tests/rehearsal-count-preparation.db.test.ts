import { randomUUID } from "node:crypto";
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
import { catalogCountHistorySchemaMigrations } from "../features/scope-sync-batches/read-model/count-schema";
import { createScopeSyncCountRuntime } from "../features/scope-sync-batches/api/count-runtime";
import { createScopeSyncBatchRuntime } from "../features/scope-sync-batches/api/runtime";
import { scopeSyncBatchRoutes } from "../features/scope-sync-batches/api/route";
import { CountAcquisitionRefused, countFingerprint } from "../features/scope-sync-batches/domain/count-acquisition";
import type { ScopeSyncBatchPreview } from "../features/scope-sync-batches/domain/batch";
import {
  acquireRehearsalCounts,
  admitRehearsalCountAcquisition,
  createRehearsalCountAdminClient,
  quoteRehearsalCounts,
} from "../features/scope-sync-batches/api/rehearsal-count-preparation";
import {
  parseRehearsalCountPreparationPass,
  rehearsalCountPreparationApprovalSchemaVersion,
  rehearsalCountPreparationSelection,
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
  let replica: Readonly<Record<"catalog", PgTransactionalPool>>;
  let now: string;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["catalog"], "rehearsal_count_preparation");
    await ensureMultiContextTestDatabases(base!, urls);
    pools = createMultiContextTestPools(urls);
    // A second pool is a second application replica on the same database.
    replica = createMultiContextTestPools(urls);
  });
  async function seed() {
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
  }
  beforeEach(seed);
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
    await closeMultiContextTestPools(replica);
  });

  type SendHook = (index: number, path: string) => Promise<Response | null> | Response | null;
  async function setup(
    remaining = 40,
    options: { pool?: PgTransactionalPool; onSend?: SendHook; environment?: string; retain?: boolean } = {},
  ) {
    const pool = options.pool ?? pools.catalog;
    const environment = options.environment ?? "staging";
    const store = createCountStore(pool, countAccountSlot(environment, "runtime"), () => now);
    if (options.retain !== false)
      await store.retainUsage({
        remainingCredits: remaining,
        totalCredits: remaining,
        observedAt: now,
        attemptState: "checked",
      } as ProviderUsageSnapshot);
    const profiles = createCatalogProviderIntegrationProfileVersionStore(pool);
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
      const fault = await options.onSend?.(sends.length, url.pathname);
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
      pool,
      store,
      environment,
      accountRevision: "runtime",
      profiles,
      adapterOptions: {
        fetch: provider,
        baseUrl: "http://127.0.0.1/onepiece/v1",
        credentials: { apiKey: "synthetic", teamId: "synthetic" },
        now: () => new Date(now),
        profileVersions: profiles,
        countReader: store,
        countEnvironment: environment,
        countAccountRevision: "runtime",
        cacheStore: createPgCatalogProviderOptionQueryCacheStore(pool),
      },
      now: () => now,
    });
    const batchTraps = {
      previewCatalogSyncScope: vi.fn(),
      enqueueCatalogSyncRun: vi.fn(),
      getCatalogSyncRun: vi.fn(),
      cancelIntegrationJob: vi.fn(),
    };
    const services = createScopeSyncBatchRuntime({ db: pool, counts, now: () => now, ...batchTraps });
    const root = new Hono<{ Variables: { context: EventStoreContext; actor: ResolvedActor | null } }>();
    root.use("*", async (c, next) => {
      c.set("context", context);
      c.set("actor", actor);
      await next();
    });
    root.route("/api/catalog/scope-sync-batches", scopeSyncBatchRoutes(services));
    const adminRequests: string[] = [];
    let beforeAcquire: (() => Promise<void>) | null = null;
    const admin = createRehearsalCountAdminClient({
      origin,
      cookie: "chase_sets_session=synthetic",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== origin) throw new Error("loopback isolation: Admin left loopback");
        adminRequests.push(`${init?.method ?? "GET"} ${url.pathname.replace(/[0-9a-f-]{36}$/, ":id")}${url.search}`);
        if (url.pathname.endsWith("/acquire")) await beforeAcquire?.();
        return root.request(url.toString(), init);
      },
    });
    return {
      store,
      counts,
      admin,
      sends,
      usage,
      adminRequests,
      batchTraps,
      setBeforeAcquire: (value: typeof beforeAcquire) => {
        beforeAcquire = value;
      },
    };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  const pass = (productDomain: string, passNumber = 1) =>
    parseRehearsalCountPreparationPass({ passNumber, productDomain, languageCode: "" });
  const dispatchId = (productDomain: string) => `9224-pass1-${productDomain}`;
  const expectValid = (receipt: RehearsalCountPreparationReceipt) =>
    expect(validateRehearsalCountPreparationReceipt(receipt, { ...run, forbiddenValues: [] }).errors).toEqual([]);
  const acquireRequests = (f: Setup) => f.adminRequests.filter((request) => request.endsWith("/counts/acquire"));
  const allocations = async () =>
    (
      await pools.catalog.query<{ event_kind: string }>(
        "SELECT event_kind FROM catalog_scope_sync_count_history WHERE event_kind IN ('allocated','allocation-ended') ORDER BY position",
      )
    ).rows.map((row) => row.event_kind);

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
  // An unrelated ordinary purchase on the same account slot: Lorcana's one cards credit.
  async function spendElsewhere(f: Setup) {
    const other = await f.counts.quoteCounts({
      selection: rehearsalCountPreparationSelection(pass("lorcana")),
      context,
    });
    return f.counts.acquireCounts({ quoteId: other.quoteId, fingerprint: other.fingerprint, context });
  }
  const reservation = (credits: number) => ({
    batchId: `job_${randomUUID()}`,
    preview: {
      selection: { mode: "ids", scopeRecordIds: [] },
      budget: { creditedProviderRequestLimits: { scrydex: credits } },
      planFingerprint: `synthetic-${randomUUID()}`,
    } as unknown as ScopeSyncBatchPreview,
    plans: [],
    context,
  });
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
    expect(receipt).toMatchObject({
      outcome: "complete",
      acquisition: { readback: { admission: "ended" } },
      accounting: { status: "complete" },
    });
    expect(f.sends).toHaveLength(4);
    expect(new Set(f.sends).size).toBe(4);
    expect(perSet(f.sends).every((count) => count <= 2)).toBe(true);
    const history = await f.store.history();
    expect(receipt.accounting!.debits.map((debit) => debit.debitId).sort()).toEqual(
      history.map((spend) => spend.debitId).sort(),
    );
    expect(f.adminRequests).toEqual([
      "POST /api/catalog/scope-sync-batches/counts/quote",
      "GET /api/catalog/scope-sync-batches/counts/quote/:id?view=preparation",
      "POST /api/catalog/scope-sync-batches/counts/acquire",
      "GET /api/catalog/scope-sync-batches/counts/quote/:id?view=preparation",
    ]);
    expect(await allocations()).toEqual(["allocated", "allocation-ended"]);
    expect((await f.store.authority()).headroom).toBe(36);

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

  it("duplicate and concurrent invocations admit one execution and add no sends beyond one per kind", async () => {
    const f = await setup();
    const quoted = await quote(f, "one-piece");
    const results = await Promise.all([acquire(f, quoted), acquire(f, quoted)]);
    expect(results.map((receipt) => receipt.outcome).sort()).toEqual(
      results.some((receipt) => receipt.outcome === "refused")
        ? ["complete", "refused"]
        : ["admission-refused", "complete"],
    );
    expect(f.sends).toHaveLength(4);
    expect(await f.store.history()).toHaveLength(4);
    expect(await allocations()).toEqual(["allocated", "allocation-ended"]);
    const replay = await acquire(f, quoted);
    expect(replay).toMatchObject({ outcome: "refused", refusal: "quote-not-pending" });
    expect(replay.accounting!.debits).toHaveLength(4);
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

  it("Probe A: an unrelated debit or reservation after the quote refuses before acquire with zero sends", async () => {
    for (const interleaving of ["debit", "reservation"] as const) {
      await seed();
      const f = await setup(4);
      const quoted = await quote(f, "one-piece");
      expect(quoted).toMatchObject({ outcome: "quoted", quote: { plannedCredits: 4, authority: { headroom: 4 } } });
      const fingerprint = quoted.quote!.authority.fingerprint;
      if (interleaving === "debit") expect((await spendElsewhere(f)).state).toBe("complete");
      else
        await pools.catalog.query(
          `INSERT INTO catalog_scope_sync_batches (batch_id,selection,budget,plan_fingerprint,preview,status,event_context)
          VALUES ('synthetic-reservation','{}','{"creditedProviderRequestLimits":{"scrydex":1}}','synthetic','{}','queued','{}')`,
        );
      expect((await f.store.authority()).fingerprint).toBe(fingerprint);
      const sendsBefore = f.sends.length;
      const debitsBefore = (await f.store.history()).length;
      const receipt = await acquire(f, quoted);
      expect(receipt, interleaving).toMatchObject({
        outcome: "refused",
        refusal: "headroom-below-planned",
        acquisition: null,
        authority: { state: "allowed", headroom: 3, usageFingerprint: fingerprint },
        accounting: { status: "complete", debits: [] },
      });
      expect(acquireRequests(f), interleaving).toEqual([]);
      expect(f.sends).toHaveLength(sendsBefore);
      expect(await f.store.history()).toHaveLength(debitsBefore);
      expect(await allocations()).toEqual([]);
    }
  });

  it("a race after the pre-read is refused by locked admission with one recorded submission and zero spend", async () => {
    const f = await setup(4);
    const quoted = await quote(f, "one-piece");
    f.setBeforeAcquire(async () => {
      expect((await spendElsewhere(f)).state).toBe("complete");
    });
    const receipt = await acquire(f, quoted);
    expect(receipt).toMatchObject({
      outcome: "admission-refused",
      acquisition: { response: { status: 409 }, readback: { status: "read", admission: "none" } },
      accounting: { status: "complete", debits: [] },
    });
    expect(acquireRequests(f)).toHaveLength(1);
    expect(f.sends).toHaveLength(1);
    expect(await allocations()).toEqual([]);
    expect((await f.store.history()).every((spend) => spend.quoteId !== quoted.quote!.quoteId)).toBe(true);
  });

  it("two replicas race whole-quote admission against ordinary claims: whole allocation or locked refusal, never a steal", async () => {
    for (let round = 0; round < 3; round++) {
      await pools.catalog.query("TRUNCATE catalog_scope_sync_count_history");
      const f = await setup(4);
      const other = await setup(4, { pool: replica.catalog, retain: false });
      const quoted = await quote(f, "one-piece");
      const [prepared, ordinary] = await Promise.all([acquire(f, quoted), spendElsewhere(other)]);
      const spends = await f.store.history();
      const own = spends.filter((spend) => spend.quoteId === quoted.quote!.quoteId);
      if (prepared.outcome === "complete") {
        expect(own).toHaveLength(4);
        expect(ordinary.state).toBe("failed");
        expect(other.sends).toEqual([]);
      } else {
        expect(["refused", "admission-refused"]).toContain(prepared.outcome);
        expect(own).toEqual([]);
        expect(ordinary.state).toBe("complete");
      }
      expect(spends.length).toBeLessThanOrEqual(4);
      expect((await f.store.authority()).headroom).toBe(4 - spends.length);
    }
  });

  it("while a send is in flight the allocation holds P without a lock: ordinary claims, reservations and mode stripping are refused", async () => {
    let f: Setup;
    let quoteId = "";
    let fingerprint = "";
    const during: Record<string, unknown> = {};
    f = await setup(4, {
      onSend: async (index) => {
        if (index !== 1) return null;
        // These run on other connections during the provider request; a held lock would deadlock them.
        during.ordinary = (await spendElsewhere(f)).state;
        during.reserve = await f.counts.reserveBatch(reservation(1)).catch((error: unknown) => error);
        during.stripped = (await f.counts.acquireCounts({ quoteId, fingerprint, context })).state;
        during.second = await f.counts
          .acquireCounts({ quoteId, fingerprint, admission: "whole-quote", context })
          .catch((error: unknown) => error);
        during.conflict = await f.store.allocationConflict(pools.catalog);
        during.headroom = (await f.store.authority()).headroom;
        return null;
      },
    });
    const quoted = await quote(f, "one-piece");
    quoteId = quoted.quote!.quoteId;
    fingerprint = quoted.quote!.fingerprint;
    const receipt = await acquire(f, quoted);
    expect(during).toMatchObject({ ordinary: "failed", stripped: "failed", conflict: true, headroom: 0 });
    expect(during.reserve).toBeInstanceOf(CountAcquisitionRefused);
    expect(during.second).toBeInstanceOf(CountAcquisitionRefused);
    expect(receipt).toMatchObject({ outcome: "complete", accounting: { status: "complete" } });
    expect(f.sends).toHaveLength(4);
    expect((await f.store.history()).map((spend) => spend.quoteId)).toEqual(Array(4).fill(quoteId));
    expect(await f.store.allocationConflict(pools.catalog)).toBe(false);
    expect(await f.counts.reserveBatch(reservation(0)).catch((error: unknown) => error)).not.toBeInstanceOf(
      CountAcquisitionRefused,
    );
  });

  it("refuses drift and stops partial failure with retained debits, released unused capacity and no reacquire", async () => {
    const drift = await setup();
    const quoted = await quote(drift, "one-piece");
    await pools.catalog.query(
      `INSERT INTO catalog_scope_records (scope_record_id,product_domain,scope_kind,reference_type_key,reference_record_id,reference_record_key,name,lifecycle_status)
      VALUES ('scope-op03','one-piece','set','one-piece-set','ref-scope-op03','OP03','Synthetic','active')`,
    );
    const drifted = await acquire(drift, quoted);
    expect(drifted).toMatchObject({ outcome: "admission-refused", acquisition: { response: { status: 409 } } });
    expect(drift.sends).toEqual([]);
    expect(await allocations()).toEqual([]);
    await pools.catalog.query("DELETE FROM catalog_scope_records WHERE scope_record_id='scope-op03'");

    const partial = await setup(40, { onSend: (index) => (index === 2 ? new Response("{}", { status: 500 }) : null) });
    const fresh = await quote(partial, "one-piece");
    const headroomBefore = (await partial.store.authority()).headroom!;
    const stopped = await acquire(partial, fresh);
    expect(stopped.outcome).toBe("failed");
    expect(stopped.acquisition?.readback).toMatchObject({ state: "failed", admission: "ended" });
    expect(partial.sends).toHaveLength(2);
    const spends = await partial.store.history();
    expect(spends.map((spend) => spend.outcome).sort()).toEqual(["complete", "failed"]);
    expect(stopped.accounting!.debits.map((debit) => [debit.debitId, debit.outcome]).sort()).toEqual(
      spends.map((spend) => [spend.debitId, spend.outcome]).sort(),
    );
    expect(await acquire(partial, fresh)).toMatchObject({ outcome: "refused", refusal: "quote-not-pending" });
    expect(partial.sends).toHaveLength(2);
    // Both debits stay retained; the two never-converted credits are released by the end.
    expect((await partial.store.authority()).headroom).toBe(headroomBefore - 2);
    await expectNoBatch(partial);
  });

  it("an interrupted execution keeps P held and its lost result acquiring until expiry, then claims stay fenced", async () => {
    const f = await setup(4);
    const quoted = await quote(f, "one-piece");
    const quoteRecord = await f.store.loadQuote(quoted.quote!.quoteId, ownerOf());
    const authority = await f.store.authority();
    // The replica died after admission and one debit, before any result or end.
    const executionId = await f.store.admit(pools.catalog, quoteRecord, ownerOf(), authority);
    await f.store.approve(pools.catalog, quoteRecord.quoteId, quoteRecord.fingerprint, ownerOf());
    const debit = await f.store.claim(
      pools.catalog,
      quoteRecord,
      quoteRecord.targets[0]!,
      ownerOf(),
      authority,
      executionId,
    );
    expect(debit).toEqual(expect.any(String));
    expect((await f.store.authority()).headroom).toBe(0);
    const view = await f.store.preparationView(quoteRecord);
    expect(view.admission.state).toBe("active");
    expect(view.debits).toMatchObject({ status: "complete", rows: [{ debitId: debit, outcome: "acquiring" }] });
    expect(await spendElsewhere(f)).toMatchObject({ state: "failed" });

    now = new Date(Date.parse(quoteRecord.expiresAt) + 1).toISOString();
    await expect(
      f.store.claim(pools.catalog, quoteRecord, quoteRecord.targets[1]!, ownerOf(), authority, executionId),
    ).rejects.toBeInstanceOf(CountAcquisitionRefused);
    const expired = await f.store.preparationView(quoteRecord);
    expect(expired.admission.state).toBe("expired");
    expect(expired.debits.rows).toMatchObject([{ debitId: debit, outcome: "acquiring" }]);
    // Expiry releases only the three unconverted credits; the possible send is never refunded.
    expect(await f.store.allocationConflict(pools.catalog)).toBe(false);
  });

  it("projects every quote debit exhaustively, isolated from other quotes, slots and owners", async () => {
    const f = await setup(500);
    const quoted = await quote(f, "one-piece");
    const quoteRecord = await f.store.loadQuote(quoted.quote!.quoteId, ownerOf());
    const debitPayload = JSON.stringify({ query: quoteRecord.targets[0]!.query, credits: 1 });
    const foreignDebit = (slot: string, quoteId: string, index: number) =>
      pools.catalog.query(
        `INSERT INTO catalog_scope_sync_count_history (event_id,account_slot,event_kind,quote_id,query_key,scope_record_id,count_kind,payload,recorded_at)
        VALUES ($1,$2,'debit',$3,$4,$5,'cards',$6::jsonb,$7::timestamptz)`,
        [randomUUID(), slot, quoteId, "f".repeat(64), `scope-other-${index}`, debitPayload, now],
      );
    // 120 debits of other quotes on this slot precede this quote's history.
    for (let index = 0; index < 120; index++) await foreignDebit(f.store.slot, randomUUID(), index);
    const receipt = await acquire(f, quoted);
    expect(receipt).toMatchObject({ outcome: "complete", accounting: { status: "complete" } });
    expect(receipt.accounting!.debits).toHaveLength(4);
    expect(receipt.accounting!.debits.every((debit) => debit.quoteId === quoteRecord.quoteId)).toBe(true);
    // The capped spend history cannot be the accounting source; the quote projection is exhaustive.
    expect((await f.store.history(100)).length).toBe(100);
    // Rows under the same quote id on another account slot are not this quote's debits.
    for (let index = 120; index < 125; index++)
      await foreignDebit(countAccountSlot("production", "runtime"), quoteRecord.quoteId, index);
    const isolated = await f.store.preparationView(quoteRecord);
    expect(isolated.debits).toMatchObject({ status: "complete", reason: null });
    expect(isolated.debits.rows.map((row) => row.debitId).sort()).toEqual(
      receipt.accounting!.debits.map((debit) => debit.debitId).sort(),
    );

    await expect(f.store.loadQuote(quoteRecord.quoteId, "another-owner")).rejects.toBeInstanceOf(
      CountAcquisitionRefused,
    );

    // A corrupted row of this quote makes the projection unknown; its readable rows are kept.
    await pools.catalog.query(
      `INSERT INTO catalog_scope_sync_count_history (event_id,account_slot,event_kind,quote_id,query_key,scope_record_id,count_kind,payload,recorded_at)
      VALUES ($1,$2,'debit',$3,$4,'scope-op09','cards','{"query":{}}'::jsonb,$5::timestamptz)`,
      [randomUUID(), f.store.slot, quoteRecord.quoteId, "e".repeat(64), now],
    );
    const unknown = await f.store.preparationView(quoteRecord);
    expect(unknown.debits).toMatchObject({ status: "unknown", reason: "invalid-row", fingerprint: null });
    expect(unknown.debits.rows).toHaveLength(4);
  });

  it("whole-quote admission is staging-only and ordinary cap-one acquisition is unchanged", async () => {
    const production = await setup(40, { environment: "production" });
    const q = await production.counts.quoteCounts({
      selection: rehearsalCountPreparationSelection(pass("one-piece")),
      cap: 1,
      context,
    });
    await expect(
      production.counts.acquireCounts({
        quoteId: q.quoteId,
        fingerprint: q.fingerprint,
        admission: "whole-quote",
        context,
      }),
    ).rejects.toBeInstanceOf(CountAcquisitionRefused);
    expect(production.sends).toEqual([]);
    const ordinary = await production.counts.acquireCounts({ quoteId: q.quoteId, fingerprint: q.fingerprint, context });
    expect(ordinary.state).toBe("failed");
    expect(production.sends).toHaveLength(1);
    expect(await allocations()).toEqual([]);
  });

  it("the ledgered upgrade admits allocation events on a retained v1 history and converges with boot", async () => {
    const f = await setup(4);
    const constraint = async () =>
      (
        await pools.catalog.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conname='catalog_scope_sync_count_history_event_kind_check'`,
        )
      ).rows.map((row) => row.definition);
    const boot = await constraint();
    expect(boot).toHaveLength(1);
    // Rebuild the shipped v1 shape with retained rows, then apply the ledgered upgrade.
    const retained = await quote(f, "lorcana");
    await pools.catalog.query("DROP TABLE catalog_scope_sync_count_history");
    await pools.catalog.query(catalogCountHistorySchemaMigrations[0]!.statements[0]!);
    await pools.catalog.query(
      `INSERT INTO catalog_scope_sync_count_history (event_id,account_slot,event_kind,quote_id,payload)
      VALUES ($1,$2,'approved',$3,'{}'::jsonb)`,
      [randomUUID(), f.store.slot, retained.quote!.quoteId],
    );
    const insertAllocation = () =>
      pools.catalog.query(
        `INSERT INTO catalog_scope_sync_count_history (event_id,account_slot,event_kind,quote_id,payload)
        VALUES ($1,$2,'allocated',$3,'{}'::jsonb)`,
        [randomUUID(), f.store.slot, randomUUID()],
      );
    await expect(insertAllocation()).rejects.toThrow();
    for (const migration of catalogCountHistorySchemaMigrations.slice(1))
      for (const sql of migration.statements) await pools.catalog.query(sql);
    for (const migration of catalogCountHistorySchemaMigrations.slice(1))
      for (const sql of migration.statements) await pools.catalog.query(sql);
    expect(await constraint()).toEqual(boot);
    await insertAllocation();
    expect(
      (await pools.catalog.query("SELECT event_kind FROM catalog_scope_sync_count_history ORDER BY position")).rows,
    ).toEqual([{ event_kind: "approved" }, { event_kind: "allocated" }]);
  });
});

// The count runtime's owner identity for the synthetic Admin context.
function ownerOf(): string {
  return countFingerprint({
    tenantId: context.tenantId,
    account: context.audit.forAccountId,
    user: context.audit.performedByUserId,
  });
}
