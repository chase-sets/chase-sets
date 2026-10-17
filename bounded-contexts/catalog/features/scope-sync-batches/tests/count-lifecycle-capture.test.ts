import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { Hono } from "hono";
import { createCountCaptureDbFixture } from "./count-capture-db-fixture";
import {
  captureActor,
  captureAuthority,
  captureContext,
  captureScope,
  captureSession,
} from "./count-capture-session-fixture";
import { scopeSyncBatchRoutes } from "../api/route";
import { runCountCaptureJourney } from "../api/count-capture-runner";
import {
  createCountCaptureLifecycle,
  readCountCaptureEvidence,
  readCountCaptureRoster,
} from "../api/count-capture-lifecycle";
import { createCatalogProviderIntegrationProfileVersionStore } from "../../source-observations/api/providers/provider-integration-profile-store";
import { readCountCaptureEffects } from "../read-model/count-capture-store";
import {
  countCaptureCollectionSchema,
  countCapturePhaseCaps,
  validateCountLifecycleReceipt,
} from "../domain/count-lifecycle-receipt";
import { captureLifecycleMutant, captureStoreMutant } from "./count-capture-counts-mutants";

const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error("TEST_DATABASE_URL is required for the count-capture lifecycle DB proof.");

describe("staging count capture lifecycle", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["catalog"], "count_lifecycle_capture_9587");
    await ensureMultiContextTestDatabases(base!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("reaches conforming through the ten-action loopback with bounded debits", async () => {
    const fixture = await createCountCaptureDbFixture(pools.catalog);
    const app = new Hono<{ Variables: { context: typeof captureContext; actor: ReturnType<typeof captureActor> } }>();
    app.use("*", async (c, next) => {
      c.set("context", captureContext);
      c.set("actor", captureActor());
      await next();
    });
    app.route("/api/catalog/scope-sync-batches", scopeSyncBatchRoutes(fixture.runtime, fixture.lifecycle));
    const authority = captureAuthority();
    const identity = { sha: authority.runnerSha, dispatchId: authority.dispatchId, scopeRecordId: captureScope };
    const paths: Record<string, [string, Record<string, unknown>]> = {
      "capture-baseline": ["/count-capture/baseline", { scopeRecordId: captureScope, authority }],
      "capture-initial-notice": ["/count-capture/initial-notice", {}],
      "capture-usage": ["/count-capture/usage", {}],
      "count-quote": ["/counts/quote", { selection: fixture.selection, budget: fixture.budget }],
      "capture-quote-readback": ["/count-capture/quote-readback", {}],
      "capture-final-notice": ["/count-capture/final-notice", {}],
      "count-acquire": ["/counts/acquire", {}],
      preview: ["/preview", { selection: fixture.selection, budget: fixture.budget }],
      "pre-confirm-planner-read": [
        "/count-capture/pre-confirm",
        { selection: fixture.selection, budget: fixture.budget },
      ],
      "capture-freeze": ["/count-capture/freeze", { runnerRunId: "300", runnerRunAttempt: 1 }],
    };
    const action = async (intent: string, fields: Readonly<Record<string, string>>) => {
      const [path, baseBody] = paths[intent]!;
      const body = { ...baseBody };
      if (intent === "capture-freeze") body.collection = JSON.parse(fields.collection);
      if (intent === "count-acquire") {
        const quote = fields.quoteId ? { quoteId: fields.quoteId, fingerprint: fields.countFingerprint } : {};
        Object.assign(body, quote);
      }
      if (intent === "preview" || intent === "pre-confirm-planner-read") body.selection = fixture.selection;
      if (intent === "pre-confirm-planner-read") body.planFingerprint = fields.planFingerprint;
      const response = await app.request(`https://admin.staging.chasesets.com/api/catalog/scope-sync-batches${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://admin.staging.chasesets.com",
          "x-catalog-count-capture": "1",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`action-${intent}-${response.status}`);
      return response.json();
    };
    const result = await runCountCaptureJourney(
      identity,
      action,
      () => fixture.clock.now,
      async () => countCaptureCollectionSchema.parse({ ...authority.collection, collectedAt: fixture.clock.now }),
    );
    const receipt = result;
    expect(receipt.schemaVersion).toBe("scope-sync-count-lifecycle/v1");
    expect(validateCountLifecycleReceipt(receipt).valid).toBe(true);
    expect(receipt.classification.verdict).toBe("CONFORMING");
    expect("sends" in receipt ? receipt.sends.length : 0).toBeLessThanOrEqual(11);
  });

  const captureDeps = (
    f: Awaited<ReturnType<typeof createCountCaptureDbFixture>>,
    overrides: Record<string, unknown> = {},
  ) => ({
    environment: "staging" as const,
    accountRevision: "runtime" as const,
    store: f.store,
    counts: f.runtime,
    readRoster: (id: string) =>
      readCountCaptureRoster(f.pool, createCatalogProviderIntegrationProfileVersionStore(f.pool), id),
    readEffects: (at: string) => readCountCaptureEffects(f.pool, at),
    countAuthority: () => f.countStore.authority(),
    observeUsage: async () => {
      throw new Error("Unexpected bootstrap.");
    },
    readCountEvidence: (q: Parameters<typeof readCountCaptureEvidence>[2]) =>
      readCountCaptureEvidence(f.pool, f.countStore.slot, q),
    now: () => f.clock.now,
    ...overrides,
  });

  function journey(
    f: Awaited<ReturnType<typeof createCountCaptureDbFixture>>,
    lifecycle = f.lifecycle,
    hook: (intent: string, post: () => Promise<Response>) => Promise<Response> = (_intent, post) => post(),
  ) {
    const intents: string[] = [];
    const app = new Hono<{ Variables: { context: typeof captureContext; actor: ReturnType<typeof captureActor> } }>();
    app.use("*", async (c, next) => {
      c.set("context", captureContext);
      c.set("actor", captureActor());
      await next();
    });
    app.route("/api/catalog/scope-sync-batches", scopeSyncBatchRoutes(f.runtime, lifecycle));
    const routePaths: Record<string, string> = {
      "capture-baseline": "/count-capture/baseline",
      "capture-initial-notice": "/count-capture/initial-notice",
      "capture-usage": "/count-capture/usage",
      "count-quote": "/counts/quote",
      "capture-quote-readback": "/count-capture/quote-readback",
      "capture-final-notice": "/count-capture/final-notice",
      "count-acquire": "/counts/acquire",
      preview: "/preview",
      "pre-confirm-planner-read": "/count-capture/pre-confirm",
      "capture-freeze": "/count-capture/freeze",
    };
    const authority = captureAuthority();
    const identity = { sha: authority.runnerSha, dispatchId: authority.dispatchId, scopeRecordId: captureScope };
    const action = async (intent: string, fields: Readonly<Record<string, string>>) => {
      intents.push(intent);
      const body: Record<string, unknown> =
        intent === "capture-baseline"
          ? { scopeRecordId: captureScope, authority }
          : intent === "count-quote" || intent === "preview" || intent === "pre-confirm-planner-read"
            ? { selection: f.selection, budget: f.budget }
            : intent === "count-acquire"
              ? { quoteId: fields.quoteId, fingerprint: fields.countFingerprint }
              : intent === "pre-confirm-planner-read"
                ? { selection: f.selection, budget: f.budget, planFingerprint: fields.planFingerprint }
                : intent === "capture-freeze"
                  ? { runnerRunId: "300", runnerRunAttempt: 1, collection: JSON.parse(fields.collection) }
                  : {};
      if (intent === "pre-confirm-planner-read") body.planFingerprint = fields.planFingerprint;
      const post = async () =>
        await app.request(`https://admin.staging.chasesets.com/api/catalog/scope-sync-batches${routePaths[intent]}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://admin.staging.chasesets.com",
            "x-catalog-count-capture": "1",
          },
          body: JSON.stringify(body),
        });
      const response = await hook(intent, post);
      if (!response.ok) throw new Error(`action-${intent}-${response.status}`);
      return response.json();
    };
    const result = runCountCaptureJourney(
      identity,
      action,
      () => f.clock.now,
      async () => countCaptureCollectionSchema.parse({ ...authority.collection, collectedAt: f.clock.now }),
    );
    return { result, intents, identity };
  }

  async function captureRunPayload(f: Awaited<ReturnType<typeof createCountCaptureDbFixture>>) {
    return (
      await f.pool.query("SELECT payload FROM catalog_scope_sync_count_capture_history ORDER BY position DESC LIMIT 1")
    ).rows[0]?.payload as { status: string; sends: unknown[] };
  }

  it("rejects unsafe lifecycle (replay)", async () => {
    const f = await createCountCaptureDbFixture(pools.catalog);
    let fetchBefore = 0;
    const { result, intents } = journey(f, f.lifecycle, async (intent, post) => {
      if (intent === "count-acquire") {
        expect((await post()).ok).toBe(true);
        fetchBefore = f.fetch.mock.calls.length;
        return post();
      }
      return post();
    });
    const stop = await result;
    expect(stop).toMatchObject({ phase: "acquisition", reason: "capture-stopped", evidence: {} });
    expect(intents.at(-1)).toBe("count-acquire");
    expect(intents).not.toContain("capture-freeze");
    expect(f.fetch).toHaveBeenCalledTimes(fetchBefore);
    expect(await f.countStore.history()).toMatchObject([
      { credits: 1, outcome: "complete" },
      { credits: 1, outcome: "complete" },
    ]);
    expect(await captureRunPayload(f)).toMatchObject({ status: "stopped", sends: expect.any(Array) });
    expect((await captureRunPayload(f)).sends).toHaveLength(2);
  });
  it("rejects unsafe lifecycle (refresh)", async () => {
    const f = await createCountCaptureDbFixture(pools.catalog);
    const first = journey(f, f.lifecycle, async (intent, post) => {
      if (intent === "count-acquire") {
        expect((await post()).ok).toBe(true);
        return post();
      }
      return post();
    });
    await first.result;
    const second = journey(f);
    const stop = await second.result;
    expect(stop).toMatchObject({ phase: "baseline", reason: "capture-stopped", evidence: {} });
    expect(second.intents.at(-1)).toBe("capture-baseline");
    expect(await f.countStore.history()).toMatchObject([
      { credits: 1, outcome: "complete" },
      { credits: 1, outcome: "complete" },
    ]);
    expect(await captureRunPayload(f)).toMatchObject({ status: "stopped", sends: expect.any(Array) });
    expect((await captureRunPayload(f)).sends).toHaveLength(2);
    expect(
      new Set(
        (await f.pool.query("SELECT run_id FROM catalog_scope_sync_count_capture_history")).rows.map((r) => r.run_id),
      ).size,
    ).toBe(1);
  });
  it("rejects unsafe lifecycle (refused authority)", async () => {
    const f = await createCountCaptureDbFixture(pools.catalog);
    let refuse = false;
    const lifecycle = createCountCaptureLifecycle(
      captureDeps(f, { countAuthority: async () => ({ ...(await f.countStore.authority()), allowed: !refuse }) }),
    );
    let fetchBefore = 0;
    const run = journey(f, lifecycle, async (intent, post) => {
      if (intent === "count-acquire") {
        refuse = true;
        fetchBefore = f.fetch.mock.calls.length;
      }
      return post();
    });
    const stop = await run.result;
    expect(stop).toMatchObject({ phase: "acquisition", reason: "capture-stopped", evidence: {} });
    expect(run.intents.at(-1)).toBe("count-acquire");
    expect(run.intents).not.toContain("capture-freeze");
    expect(f.fetch).toHaveBeenCalledTimes(fetchBefore);
    expect(await f.countStore.history()).toEqual([]);
    expect(await captureRunPayload(f)).toMatchObject({ status: "stopped", sends: [] });
  });
  it("rejects unsafe lifecycle (cap overflow)", async () => {
    const f = await createCountCaptureDbFixture(pools.catalog);
    let raise = false;
    const raised = {
      ...f.runtime,
      getCountQuote: async (input: Parameters<typeof f.runtime.getCountQuote>[0]) => {
        const q = await f.runtime.getCountQuote(input);
        return raise ? { ...q, cap: countCapturePhaseCaps.acquisition + 1 } : q;
      },
    };
    const lifecycle = createCountCaptureLifecycle(captureDeps(f, { counts: raised }));
    let fetchBefore = 0;
    const run = journey(f, lifecycle, async (intent, post) => {
      if (intent === "count-acquire") {
        raise = true;
        fetchBefore = f.fetch.mock.calls.length;
      }
      return post();
    });
    const stop = await run.result;
    expect(stop).toMatchObject({ phase: "acquisition", reason: "capture-stopped", evidence: {} });
    expect(run.intents.at(-1)).toBe("count-acquire");
    expect(run.intents).not.toContain("capture-freeze");
    expect(f.fetch).toHaveBeenCalledTimes(fetchBefore);
    expect(await f.countStore.history()).toEqual([]);
    expect(await captureRunPayload(f)).toMatchObject({ status: "stopped", sends: [] });
  });

  it("the replay guard-disabled mutant proceeds past acquisition", async () => {
    const f = await createCountCaptureDbFixture(pools.catalog);
    const store = captureStoreMutant([
      ["(last !== undefined && phaseOrder(phase) <= phaseOrder(last))", "false"],
      ["index === 0 || phaseOrder(run.phases[index - 1]!) < phaseOrder(phase)", "true"],
      [
        "run.quote.fingerprint !== fingerprint ||\n          run.approvalAt ||\n          !run.finalNotice?.readBackAt",
        "run.quote.fingerprint !== fingerprint || !run.finalNotice?.readBackAt",
      ],
      [
        "inPhase.length >= countCapturePhaseCaps[phase]",
        "(phase !== 'acquisition' && inPhase.length >= countCapturePhaseCaps[phase])",
      ],
      ["inPhase.length >= run.quote.cap", "false"],
      ["inPhase.some((entry) => entry.category === send.category)", "false"],
    ])(f.pool, () => f.clock.now);
    const lifecycle = createCountCaptureLifecycle(captureDeps(f, { store }));
    const run = journey(f, lifecycle, async (intent, post) => {
      if (intent === "count-acquire") {
        await post();
        return post();
      }
      return post();
    });
    expect(run.intents.at(-1)).not.toBe("count-acquire");
  });
  it("the refresh guard-disabled mutant proceeds past baseline", async () => {
    const f = await createCountCaptureDbFixture(pools.catalog);
    const first = journey(f, f.lifecycle, async (intent, post) => {
      if (intent === "count-acquire") {
        await post();
        return post();
      }
      return post();
    });
    await first.result;
    const store = captureStoreMutant([
      [
        "if (retained.some((run) => run.host.dispatchId === input.host.dispatchId)) throw new CountCaptureStopped();",
        "",
      ],
    ])(f.pool, () => f.clock.now);
    const lifecycle = createCountCaptureLifecycle(captureDeps(f, { store }));
    const run = journey(f, lifecycle);
    expect(((await run.result) as { reason?: string }).reason).not.toBe("capture-stopped");
    expect(run.intents.at(-1)).not.toBe("capture-baseline");
  });
  it("the refused authority guard-disabled mutant proceeds past acquisition", async () => {
    const f = await createCountCaptureDbFixture(pools.catalog);
    const lifecycle = captureLifecycleMutant([["!authority.allowed ||", ""]], {
      countAuthority: async () => ({ ...(await f.countStore.authority()), allowed: false }),
    })(captureDeps(f));
    const run = journey(f, lifecycle);
    expect(((await run.result) as { reason?: string }).reason).not.toBe("capture-stopped");
    expect(run.intents.at(-1)).not.toBe("count-acquire");
  });
  it("the cap overflow guard-disabled mutant proceeds past acquisition", async () => {
    const f = await createCountCaptureDbFixture(pools.catalog);
    const counts = {
      ...f.runtime,
      getCountQuote: async (input: Parameters<typeof f.runtime.getCountQuote>[0]) => ({
        ...(await f.runtime.getCountQuote(input)),
        cap: countCapturePhaseCaps.acquisition + 1,
      }),
    };
    const lifecycle = captureLifecycleMutant(
      [["countFingerprint(normalized) !== countFingerprint(run.quote)", "false"]],
      { counts },
    )(
      captureDeps(f, {
        counts,
        store: captureStoreMutant([
          ["countFingerprint(run.quote) !== countFingerprint(quote)", "false"],
          ["result.cap !== run.quote.cap", "false"],
        ])(f.pool, () => f.clock.now),
      }),
    );
    const run = journey(f, lifecycle);
    expect(((await run.result) as { reason?: string }).reason).not.toBe("capture-stopped");
    expect(run.intents.at(-1)).not.toBe("count-acquire");
  });
});
