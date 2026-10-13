import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCountCaptureStore } from "./count-capture-store";
import { countCaptureSchemaSql, countCaptureSchemaMigrations } from "./count-capture-schema";
import { syntheticCountCaptureAuthority } from "../tests/count-capture-fixture";
import { normalizeScopeSyncBatchBudget } from "../domain/batch";
import { syntheticCountLifecycleReceipt } from "../tests/count-lifecycle-receipt-fixture";

const base = process.env.TEST_DATABASE_URL;
if (!base && process.env.CI) throw new Error("TEST_DATABASE_URL is required for capture atomicity proof.");
const describeDb = base ? describe : describe.skip;
describeDb("caps actual sends across durable capture replicas", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;
  const now = () => "2026-10-13T08:04:00.000Z";
  const selection = { mode: "ids" as const, scopeRecordIds: ["synthetic-scope"] };
  const admit = (owner: string, dispatch = owner) => ({
    ownerHash: owner.repeat(64),
    authority: syntheticCountCaptureAuthority(`synthetic-${dispatch}`),
    selection,
    budget: normalizeScopeSyncBatchBudget(),
  });
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["catalog"], "count_capture_atomicity_9520");
    await ensureMultiContextTestDatabases(base!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(countCaptureSchemaSql);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("upgrades an existing database and preserves retained runs when reapplied", async () => {
    await pools.catalog.query("DROP TABLE catalog_scope_sync_count_capture_history");
    for (const migration of countCaptureSchemaMigrations)
      for (const statement of migration.statements) await pools.catalog.query(statement);
    const store = createCountCaptureStore(pools.catalog, now);
    const admitted = await store.admit(admit("a"));
    for (const migration of countCaptureSchemaMigrations)
      for (const statement of migration.statements) await pools.catalog.query(statement);
    expect(await store.findOwner(admitted.ownerHash)).toEqual(admitted);
    expect(
      (
        await pools.catalog.query<{ count: string }>(
          "SELECT count(*)::text FROM catalog_scope_sync_count_capture_history",
        )
      ).rows[0]?.count,
    ).toBe("1");
  });

  it("a stale run's later failure cannot hide another active run", async () => {
    const store = createCountCaptureStore(pools.catalog, now);
    const stale = await store.admit(admit("a"));
    await store.transition(stale.runId, "admitted", "failed");
    const active = await store.admit(admit("b"));
    await expect(store.begin(stale.runId, "baseline")).rejects.toThrow("capture-stopped");
    await expect(store.admit(admit("c"))).rejects.toThrow("capture-stopped");
    expect((await store.findOwner(active.ownerHash))?.stage).toBe("admitted");
  });
  it("retains all dispatch identities after newer runs complete", async () => {
    const store = createCountCaptureStore(pools.catalog, now);
    for (const owner of ["a", "b"]) {
      const run = await store.admit(admit(owner));
      await store.transition(run.runId, "admitted", "failed");
    }
    await expect(store.admit(admit("c", "a"))).rejects.toThrow("capture-stopped");
  });
  it("serializes admissions and debits across independent store instances", async () => {
    const first = createCountCaptureStore(pools.catalog, now);
    const second = createCountCaptureStore(pools.catalog, now);
    const outcomes = await Promise.allSettled([first.admit(admit("a")), second.admit(admit("b"))]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const accepted = outcomes.find((result) => result.status === "fulfilled");
    if (accepted?.status !== "fulfilled") throw new Error("No admitted synthetic capture.");
    await first.transition(accepted.value.runId, "admitted", "noticed");
    const binding = await first.begin(accepted.value.runId, "bootstrap");
    const send = {
      category: "usage" as const,
      requestFingerprint: "d".repeat(64),
      usage: { purpose: "bootstrap" as const },
    };
    const debits = await Promise.allSettled([first.ledger.debit(binding, send), second.ledger.debit(binding, send)]);
    expect(debits.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const retained = await first.findOwner(accepted.value.ownerHash);
    expect(retained?.sends).toHaveLength(1);
    expect(retained?.stage).toBe("failed");
    expect(retained?.sends[0]?.status).toBeNull();
  });
  it("does not turn four planImport slots into a transferable readiness allowance", async () => {
    const store = createCountCaptureStore(pools.catalog, now);
    const run = await store.admit(admit("a"));
    await store.transition(run.runId, "admitted", "noticed");
    const quoting = await store.begin(run.runId, "quote");
    const receipt = syntheticCountLifecycleReceipt();
    await store.bindQuote(quoting, {
      quoteId: receipt.notices.quoteId,
      fingerprint: receipt.notices.quoteFingerprint,
      membershipFingerprint: receipt.notices.membershipFingerprint,
      selection,
      authority: { allowed: true, headroom: 100, fingerprint: receipt.notices.authorityFingerprint },
      targets: receipt.acquisitions.map((acquired) => ({
        scopeRecordId: "synthetic-scope",
        query: acquired.evidence.query,
        source: acquired.evidence,
        blocked: false,
      })),
      plannedCredits: 0,
      cap: 0,
      expiresAt: "2026-10-13T08:15:00.000Z",
      state: "quoted",
    });
    await store.finish(quoting);
    await store.transition(run.runId, "quoted", "approved");
    await store.finish(await store.begin(run.runId, "acquisition"));
    const binding = await store.begin(run.runId, "preview");
    const send = {
      category: "usage" as const,
      requestFingerprint: "d".repeat(64),
      usage: { purpose: "readiness" as const },
    };
    const first = await store.ledger.debit(binding, send);
    await store.ledger.result(binding, first, 200);
    await expect(store.ledger.debit(binding, send)).rejects.toThrow("capture-stopped");
    expect((await store.findOwner(run.ownerHash))?.sends).toHaveLength(1);
  });
  it("cannot skip the quote and approval by requesting a later stage", async () => {
    const store = createCountCaptureStore(pools.catalog, now);
    const run = await store.admit(admit("a"));
    await expect(store.transition(run.runId, "admitted", "acquired")).rejects.toThrow("capture-stopped");
    expect((await store.findOwner(run.ownerHash))?.stage).toBe("failed");
  });
  it("requires the persisted quote before completing its phase", async () => {
    const store = createCountCaptureStore(pools.catalog, now);
    const run = await store.admit(admit("a"));
    await store.transition(run.runId, "admitted", "noticed");
    const binding = await store.begin(run.runId, "quote");
    await expect(store.finish(binding)).rejects.toThrow("capture-stopped");
    expect((await store.findOwner(run.ownerHash))?.stage).toBe("failed");
  });
  it.each(["retained", "missing", "duplicate", "wrong-request"])(
    "requires request-bound durable planner evidence: %s",
    async (mode) => {
      const store = createCountCaptureStore(pools.catalog, now);
      const run = await store.admit(admit("a"));
      await store.transition(run.runId, "admitted", "noticed");
      const quoting = await store.begin(run.runId, "quote");
      const receipt = syntheticCountLifecycleReceipt();
      await store.bindQuote(quoting, {
        quoteId: receipt.notices.quoteId,
        fingerprint: receipt.notices.quoteFingerprint,
        membershipFingerprint: receipt.notices.membershipFingerprint,
        selection,
        authority: { allowed: true, headroom: 100, fingerprint: receipt.notices.authorityFingerprint },
        targets: receipt.acquisitions.map((acquired) => ({
          scopeRecordId: "synthetic-scope",
          query: acquired.evidence.query,
          source: acquired.evidence,
          blocked: false,
        })),
        plannedCredits: 0,
        cap: 0,
        expiresAt: "2026-10-13T08:15:00.000Z",
        state: "quoted",
      });
      await store.finish(quoting);
      await store.transition(run.runId, "quoted", "approved");
      await store.finish(await store.begin(run.runId, "acquisition"));
      const binding = await store.begin(run.runId, "preview");
      const read = {
        phase: "preview" as const,
        requestId: binding.requestId,
        planFingerprint: "a".repeat(64),
        comparedFingerprint: null,
        eligible: false,
        refusal: null,
        effectsCapability: false as const,
        winners: [],
      };
      if (mode === "wrong-request") {
        await expect(
          store.retainPlannerRead(binding, { ...read, requestId: "00000000-0000-4000-8000-000000000099" }),
        ).rejects.toThrow("capture-stopped");
      } else if (mode !== "missing") {
        await store.retainPlannerRead(binding, read);
        if (mode === "duplicate")
          await expect(store.retainPlannerRead(binding, read)).rejects.toThrow("capture-stopped");
      }
      if (mode === "retained") {
        await store.finish(binding);
        expect((await store.findOwner(run.ownerHash))?.plannerReads).toEqual([read]);
      } else {
        await expect(store.finish(binding)).rejects.toThrow("capture-stopped");
        expect((await store.findOwner(run.ownerHash))?.stage).toBe("failed");
      }
    },
  );
  it("refuses a late possible send after its request has finished", async () => {
    const store = createCountCaptureStore(pools.catalog, now);
    const run = await store.admit(admit("a"));
    await store.transition(run.runId, "admitted", "noticed");
    const binding = await store.begin(run.runId, "bootstrap");
    await store.finish(binding);
    await expect(
      store.ledger.debit(binding, {
        category: "usage",
        requestFingerprint: "d".repeat(64),
        usage: { purpose: "bootstrap" },
      }),
    ).rejects.toThrow("capture-stopped");
    expect((await store.findOwner(run.ownerHash))?.sends).toHaveLength(0);
  });
});
