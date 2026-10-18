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

  type Replacements = readonly (readonly [string, string])[];
  type HostileKind = "replay" | "refresh" | "refused-authority" | "cap-overflow";
  type HostileMutant = { lifecycle?: Replacements; store?: Replacements };

  const hostileGuardId = (kind: HostileKind) => `count-capture-${kind}`;
  const hostileBoundary = (kind: HostileKind) => (kind === "refresh" ? "capture-baseline" : "count-acquire");

  async function assertSettledHostileState(
    f: Awaited<ReturnType<typeof createCountCaptureDbFixture>>,
    kind: HostileKind,
    result: unknown,
    progressed: boolean,
    fetchBefore: number,
    intents: readonly string[],
  ) {
    const payload = (await captureRunPayload(f)) as {
      schemaVersion: number;
      status: "open" | "stopped" | "frozen";
      request: unknown;
      phases: readonly string[];
      sends: readonly { status: unknown }[];
      receipt?: { schemaVersion?: string };
    };
    const countLedger = await f.countStore.history();
    expect(payload.schemaVersion).toBe(1);
    expect(payload.request).toBeNull();
    expect(payload.status).toBe(progressed ? "frozen" : "stopped");
    expect(payload.phases.at(-1)).toBe(
      progressed ? "freeze" : hostileBoundary(kind) === "capture-baseline" ? "baseline" : "acquisition",
    );
    expect(payload.sends.every((send) => send.status !== null)).toBe(true);
    expect(countLedger.every((entry) => entry.credits === 1 && entry.outcome === "complete")).toBe(true);
    if (progressed) expect(f.fetch.mock.calls.length).toBeGreaterThan(fetchBefore);
    else expect(f.fetch.mock.calls.length).toBe(fetchBefore);
    if (progressed) {
      expect(payload.receipt?.schemaVersion).toMatch(/^scope-sync-count-lifecycle(?:-stop)?\/v1$/);
      expect(result).toEqual(payload.receipt);
      expect(intents.at(-1)).toBe("capture-freeze");
    } else {
      expect(result).toMatchObject({ schemaVersion: "scope-sync-count-lifecycle-stop/v1", evidence: {} });
      expect(payload.receipt).toBeUndefined();
      expect(intents.at(-1)).toBe(hostileBoundary(kind));
    }
  }

  async function runHostilePair(kind: HostileKind, mutant: HostileMutant) {
    const controlFixture = await createCountCaptureDbFixture(pools.catalog);
    const control = await hostile(controlFixture, kind);
    await assertSettledHostileState(controlFixture, kind, control.stop, false, control.fetchBefore, control.intents);
    let red: unknown;
    try {
      await assertSettledHostileState(controlFixture, kind, control.stop, true, control.fetchBefore, control.intents);
    } catch (error) {
      red = error;
    }
    expect(red).toBeDefined();
    console.log(`AC2 guard=${hostileGuardId(kind)} RED`);

    await resetMultiContextTestSchemas(pools);
    const mutantFixture = await createCountCaptureDbFixture(pools.catalog);
    const mutated = await hostile(mutantFixture, kind, mutant);
    await assertSettledHostileState(mutantFixture, kind, mutated.stop, true, mutated.fetchBefore, mutated.intents);
    console.log(`AC2 guard=${hostileGuardId(kind)} GREEN`);
  }

  async function hostile(
    f: Awaited<ReturnType<typeof createCountCaptureDbFixture>>,
    kind: HostileKind,
    mutant?: HostileMutant,
  ) {
    let refuse = false;
    let raise = false;
    let fetchBefore = 0;
    const countAuthority =
      kind === "refused-authority"
        ? async () => ({ ...(await f.countStore.authority()), allowed: !refuse })
        : undefined;
    const counts =
      kind === "cap-overflow"
        ? {
            ...f.runtime,
            getCountQuote: async (input: Parameters<typeof f.runtime.getCountQuote>[0]) => {
              const q = await f.runtime.getCountQuote(input);
              return { ...q, cap: raise ? countCapturePhaseCaps.acquisition + 1 : countCapturePhaseCaps.acquisition };
            },
          }
        : undefined;
    const overrides = {
      ...(countAuthority ? { countAuthority } : {}),
      ...(counts ? { counts } : {}),
    };
    const hook = async (intent: string, post: () => Promise<Response>) => {
      if (intent === "count-acquire") {
        if (kind === "replay" || kind === "refresh") {
          expect((await post()).ok).toBe(true);
          fetchBefore = f.fetch.mock.calls.length;
          return post();
        }
        if (kind === "refused-authority") {
          refuse = true;
        }
        if (kind === "cap-overflow") {
          raise = true;
        }
        fetchBefore = f.fetch.mock.calls.length;
      }
      return post();
    };

    if (kind === "refresh") {
      const first = journey(f, f.lifecycle, hook);
      await first.result;
      const secondStore = mutant?.store ? captureStoreMutant(mutant.store)(f.pool, () => f.clock.now) : f.store;
      const secondLifecycle = mutant?.lifecycle
        ? captureLifecycleMutant(mutant.lifecycle)(captureDeps(f, { ...overrides, store: secondStore }))
        : createCountCaptureLifecycle(captureDeps(f, { ...overrides, store: secondStore }));
      const second = journey(f, secondLifecycle);
      const stop = await second.result;
      return { stop, intents: second.intents, fetchBefore };
    }

    const store = mutant?.store ? captureStoreMutant(mutant.store)(f.pool, () => f.clock.now) : f.store;
    const lifecycle = mutant?.lifecycle
      ? captureLifecycleMutant(mutant.lifecycle)(captureDeps(f, { ...overrides, store }))
      : createCountCaptureLifecycle(captureDeps(f, { ...overrides, store }));
    const run = journey(f, lifecycle, hook);
    const stop = await run.result;
    return { stop, intents: run.intents, fetchBefore };
  }

  it("rejects unsafe lifecycle (replay)", async () => {
    const f = await createCountCaptureDbFixture(pools.catalog);
    const result = await hostile(f, "replay");
    const { fetchBefore } = result;
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
    await hostile(f, "refresh");
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
    const { fetchBefore } = await hostile(f, "refused-authority");
    expect(f.fetch).toHaveBeenCalledTimes(fetchBefore);
    expect(await f.countStore.history()).toEqual([]);
    expect(await captureRunPayload(f)).toMatchObject({ status: "stopped", sends: [] });
  });
  it("rejects unsafe lifecycle (cap overflow)", async () => {
    const f = await createCountCaptureDbFixture(pools.catalog);
    await hostile(f, "cap-overflow");
    expect(await f.countStore.history()).toEqual([]);
    expect(await captureRunPayload(f)).toMatchObject({ status: "stopped", sends: [] });
  });

  it("the replay guard-disabled mutant proceeds past acquisition", async () => {
    await runHostilePair("replay", {
      lifecycle: [["countFingerprint(normalized) !== countFingerprint(run.quote)", "false"]],
      store: [
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
        ["sends.length !== run.quote?.plannedCredits", "false"],
      ],
    });
  });
  it("the refresh guard-disabled mutant proceeds past baseline", async () => {
    await runHostilePair("refresh", {
      store: [
        [
          "if (retained.some((run) => run.host.dispatchId === input.host.dispatchId)) throw new CountCaptureStopped();",
          "",
        ],
      ],
    });
  });
  it("the refused authority guard-disabled mutant proceeds past acquisition", async () => {
    await runHostilePair("refused-authority", { lifecycle: [["!authority.allowed ||", ""]] });
  });
  it("the cap overflow guard-disabled mutant proceeds past acquisition", async () => {
    await runHostilePair("cap-overflow", {
      lifecycle: [["countFingerprint(normalized) !== countFingerprint(run.quote)", "false"]],
      store: [
        ["countFingerprint(run.quote) !== countFingerprint(quote)", "false"],
        ["result.fingerprint !== run.quote.fingerprint", "false"],
        ["result.cap !== run.quote.cap", "false"],
      ],
    });
  });
});
