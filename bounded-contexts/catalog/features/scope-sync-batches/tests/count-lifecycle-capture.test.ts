import { isDeepStrictEqual } from "node:util";
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
  captureAt,
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
import { readCountCaptureEffects, type CountCaptureRun } from "../read-model/count-capture-store";
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

  it("RUN-G1 reaches CONFORMING through the eleven-action loopback under an advancing clock", async () => {
    const fixture = await createCountCaptureDbFixture(pools.catalog);
    // One clock for runner, routes, lifecycle and store; every read advances it, so
    // no two observations share an instant and the seal is a genuinely later read.
    let at = Date.parse(fixture.clock.now);
    Object.defineProperty(fixture.clock, "now", {
      get: () => new Date((at += 7)).toISOString(),
      set: (value: string) => {
        at = Date.parse(value);
      },
    });
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
      "capture-complete": ["/count-capture/complete", { runnerRunId: "300", runnerRunAttempt: 1 }],
    };
    const intents: string[] = [];
    const answered: string[] = [];
    let sealed: { runId: string; frozenAt: string } | null = null;
    const action = async (intent: string, fields: Readonly<Record<string, string>>) => {
      intents.push(intent);
      const [path, baseBody] = paths[intent]!;
      const body = { ...baseBody };
      // The superseded protocol sent its collection with the seal; it is forwarded as sent.
      if (fields.collection) body.collection = JSON.parse(fields.collection);
      if (fields.dispatchId) body.dispatchId = fields.dispatchId;
      if (fields.runId) body.runId = fields.runId;
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
      answered.push(`${intent}:${response.status}`);
      if (!response.ok) throw new Error(`action-${intent}-${response.status}`);
      const value = await response.json();
      if (intent === "capture-freeze") sealed = value;
      return value;
    };
    const supplied: string[] = [];
    const result = await runCountCaptureJourney(
      identity,
      action,
      () => fixture.clock.now,
      async (_deployment, collectedAt) => {
        supplied.push(collectedAt);
        return countCaptureCollectionSchema.parse({ ...authority.collection, collectedAt });
      },
    );
    // Every action answered and the journey returned the server receipt, not a
    // runner-local stop, so a failure names the refused step and its stop reason.
    expect(answered).toEqual(Object.keys(paths).map((intent) => `${intent}:200`));
    const stop = result as { phase?: unknown; reason?: unknown };
    expect({ phase: stop.phase, reason: stop.reason }).toEqual({ phase: undefined, reason: undefined });
    const validation = validateCountLifecycleReceipt(result);
    expect(validation.classification).toMatchObject({ verdict: "CONFORMING", reasons: [] });
    expect(validation.valid).toBe(true);
    expect(intents.slice(-2)).toEqual(["capture-freeze", "capture-complete"]);
    const receipt = result as Extract<typeof result, { freezeCollection: unknown }>;
    expect(receipt.frozenAt).toBe(sealed!.frozenAt);
    expect(receipt.freezeCollection.collectedAt).toBe(supplied[1]);
    expect(Date.parse(receipt.freezeCollection.collectedAt)).toBeGreaterThan(Date.parse(receipt.frozenAt));
    expect(receipt.sends.length).toBeLessThanOrEqual(11);
    // The one retained receipt is the returned one, on the sealed run.
    const [run] = await captureRuns(fixture);
    expect(run).toMatchObject({ status: "frozen", frozenAt: receipt.frozenAt, receipt });
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
      "capture-complete": "/count-capture/complete",
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
                  ? { dispatchId: fields.dispatchId, runnerRunId: "300", runnerRunAttempt: 1 }
                  : intent === "capture-complete"
                    ? {
                        runId: fields.runId,
                        dispatchId: fields.dispatchId,
                        runnerRunId: "300",
                        runnerRunAttempt: 1,
                        collection: JSON.parse(fields.collection!),
                      }
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
      async (_deployment, collectedAt) => countCaptureCollectionSchema.parse({ ...authority.collection, collectedAt }),
    );
    return { result, intents, identity };
  }

  type Fixture = Awaited<ReturnType<typeof createCountCaptureDbFixture>>;
  type Replacements = readonly (readonly [string, string])[];
  type HostileKind = "replay" | "refresh" | "refused-authority" | "cap-overflow";
  type HostileMutant = { lifecycle?: Replacements; store?: Replacements };
  type LedgerSample = { fetch: number; count: number; capture: number };
  type BoundaryAction = { intent: string; status: number; outcome: string };

  const hostileGuardId = (kind: HostileKind) => `count-capture-${kind}`;
  const hostileBoundary = (kind: HostileKind) => (kind === "refresh" ? "capture-baseline" : "count-acquire");
  const hostileNext = (kind: HostileKind) => (kind === "refresh" ? "capture-initial-notice" : "preview");

  // The latest persisted payload of every run, in admission order.
  async function captureRuns(f: Fixture) {
    const rows = await f.pool.query<{ run_id: string; payload: unknown }>(
      "SELECT run_id, payload FROM catalog_scope_sync_count_capture_history ORDER BY position",
    );
    const latest = new Map<string, CountCaptureRun>();
    for (const row of rows.rows) latest.set(row.run_id, row.payload as CountCaptureRun);
    return [...latest.values()];
  }

  async function ledgerSample(f: Fixture): Promise<LedgerSample> {
    return {
      fetch: f.fetch.mock.calls.length,
      count: (await f.countStore.history()).length,
      capture: (await captureRuns(f)).flatMap((run) => run.sends).length,
    };
  }

  const actionOutcome = (body: unknown) => {
    const value = body as { retained?: unknown; baseline?: unknown; error?: { code?: unknown } };
    if (value.retained === true) return "retained";
    if (value.baseline) return "admitted";
    return String(value.error?.code ?? "unrecognized");
  };

  // One awaited journey per half with the same deps and fields; only the admitted mutation differs.
  // The hook records the guarded action, then synthetically cuts at the first genuine next intent
  // before it posts. Intact controls never reach that cut; the conforming journey runs without it.
  async function observeHostile(kind: HostileKind, mutant?: HostileMutant) {
    const f = await createCountCaptureDbFixture(pools.catalog);
    const boundary = hostileBoundary(kind);
    const seen: { action: BoundaryAction | null; cut: string | null; before: LedgerSample | null } = {
      action: null,
      cut: null,
      before: null,
    };
    let refuse = false;
    let raise = false;
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
    const store = mutant?.store ? captureStoreMutant(mutant.store)(f.pool, () => f.clock.now) : f.store;
    const deps = captureDeps(f, {
      ...(countAuthority ? { countAuthority } : {}),
      ...(counts ? { counts } : {}),
      store,
    });
    const lifecycle = mutant?.lifecycle
      ? captureLifecycleMutant(mutant.lifecycle)(deps)
      : createCountCaptureLifecycle(deps);
    const record = async (response: Response) => {
      seen.action = {
        intent: boundary,
        status: response.status,
        outcome: actionOutcome(await response.clone().json()),
      };
      return response;
    };
    const cut = async (intent: string, post: () => Promise<Response>) => {
      if (intent === hostileNext(kind)) {
        seen.cut = intent;
        throw new Error(`AC2 synthetic cut before ${intent}`);
      }
      if (intent !== boundary) return post();
      if (kind === "replay") {
        await post();
        seen.before = await ledgerSample(f);
        return record(await post());
      }
      if (kind === "refused-authority") refuse = true;
      if (kind === "cap-overflow") raise = true;
      seen.before = await ledgerSample(f);
      return record(await post());
    };

    // Refresh replays one dispatch: journey one is the uncut, unmutated replay stop.
    let firstJourney: { runner: unknown; lastIntent: string | null } | null = null;
    let original: CountCaptureRun | null = null;
    if (kind === "refresh") {
      const first = journey(f, f.lifecycle, async (intent, post) => {
        if (intent !== "count-acquire") return post();
        await post();
        return post();
      });
      firstJourney = { runner: await first.result, lastIntent: first.intents.at(-1) ?? null };
      original = (await captureRuns(f))[0] ?? null;
    }
    const run = journey(f, lifecycle, cut);
    const runner = await run.result;
    return {
      runner,
      intents: run.intents,
      ...seen,
      after: await ledgerSample(f),
      firstJourney,
      original,
      runs: await captureRuns(f),
      counts: await f.countStore.history(),
    };
  }
  type HostileObservation = Awaited<ReturnType<typeof observeHostile>>;

  // The settled runner and persisted-ledger matrix. Dynamic IDs are reduced to their binding.
  function hostileState(o: HostileObservation) {
    const quoteId = o.runs[0]?.quote?.quoteId;
    return {
      runner: o.runner,
      lastIntent: o.intents.at(-1) ?? null,
      cut: o.cut,
      freezeIntent: o.intents.includes("capture-freeze"),
      firstJourney: o.firstJourney,
      originalUnchanged: o.original && isDeepStrictEqual(o.original, o.runs[0]),
      runs: o.runs.map((run) => ({
        schemaVersion: run.schemaVersion,
        status: run.status,
        phase: run.phases.at(-1) ?? null,
        request: run.request,
        receipt: run.receipt,
        frozenAt: run.frozenAt,
        sends: run.sends.length,
        quoteCap: run.quote?.cap ?? null,
        acquisition: run.acquisition && (run.acquisition.quoteId === run.quote?.quoteId ? "bound" : "unbound"),
      })),
      counts: o.counts
        .map((entry) => ({
          kind: entry.kind,
          credits: entry.credits,
          outcome: entry.outcome,
          quote: entry.quoteId === quoteId ? "bound" : "unbound",
        }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
      countCredits: o.counts.reduce((total, entry) => total + entry.credits, 0),
      sends: o.runs
        .flatMap((run) =>
          run.sends.map((send) => ({
            phase: send.phase,
            category: send.category,
            status: send.status,
            request: send.requestId === run.sends[0]?.requestId ? "shared" : "split",
          })),
        )
        .sort((a, b) => a.category.localeCompare(b.category)),
      delta: o.before && {
        fetch: o.after.fetch - o.before.fetch,
        count: o.after.count - o.before.count,
        capture: o.after.capture - o.before.capture,
      },
    };
  }

  const stopAt = (phase: string) => ({
    schemaVersion: "scope-sync-count-lifecycle-stop/v1",
    stoppedAt: captureAt,
    phase,
    reason: "capture-stopped",
    evidence: {},
  });
  const settledRun = {
    schemaVersion: 1,
    phase: "acquisition",
    request: null,
    receipt: null,
    frozenAt: null,
    quoteCap: countCapturePhaseCaps.acquisition,
  };
  const acquiredRun = (status: "open" | "stopped") => ({ ...settledRun, status, sends: 2, acquisition: "bound" });
  const refusedRun = {
    ...settledRun,
    status: "stopped",
    request: {
      requestId: expect.stringMatching(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
      phase: "acquisition",
    },
    sends: 0,
    acquisition: null,
  };
  const admittedRun = { ...settledRun, status: "open", phase: "baseline", sends: 0, quoteCap: null, acquisition: null };
  const acquired = {
    counts: ["cards", "sealed"].map((kind) => ({ kind, credits: 1, outcome: "complete", quote: "bound" })),
    countCredits: 2,
    sends: ["cards", "sealed"].map((category) => ({ phase: "acquisition", category, status: 200, request: "shared" })),
  };
  const zero = { fetch: 0, count: 0, capture: 0 };
  const single = { freezeIntent: false, firstJourney: null, originalUnchanged: null };
  const refreshed = {
    freezeIntent: false,
    firstJourney: { runner: stopAt("acquisition"), lastIntent: "count-acquire" },
    originalUnchanged: true,
  };
  const refusedPair = {
    intact: {
      ...single,
      runner: stopAt("acquisition"),
      lastIntent: "count-acquire",
      cut: null,
      runs: [refusedRun],
      counts: [],
      countCredits: 0,
      sends: [],
      delta: zero,
    },
    disabled: {
      ...single,
      ...acquired,
      runner: stopAt("preview"),
      lastIntent: "preview",
      cut: "preview",
      runs: [acquiredRun("open")],
      delta: { fetch: 2, count: 2, capture: 2 },
    },
  };
  const hostileRows = {
    replay: {
      intact: {
        ...single,
        ...acquired,
        runner: stopAt("acquisition"),
        lastIntent: "count-acquire",
        cut: null,
        runs: [acquiredRun("stopped")],
        delta: zero,
      },
      disabled: {
        ...single,
        ...acquired,
        runner: stopAt("preview"),
        lastIntent: "preview",
        cut: "preview",
        runs: [acquiredRun("open")],
        delta: zero,
      },
    },
    refresh: {
      intact: {
        ...refreshed,
        ...acquired,
        runner: stopAt("baseline"),
        lastIntent: "capture-baseline",
        cut: null,
        runs: [acquiredRun("stopped")],
        delta: zero,
      },
      disabled: {
        ...refreshed,
        ...acquired,
        runner: stopAt("baseline"),
        lastIntent: "capture-initial-notice",
        cut: "capture-initial-notice",
        runs: [acquiredRun("stopped"), admittedRun],
        delta: zero,
      },
    },
    "refused-authority": refusedPair,
    "cap-overflow": refusedPair,
  };

  const progressionFor = (kind: HostileKind) => ({
    guard: hostileGuardId(kind),
    action: { intent: hostileBoundary(kind), status: 200, outcome: kind === "refresh" ? "admitted" : "retained" },
    next: hostileNext(kind),
  });

  const observedProgression = (kind: HostileKind, o: HostileObservation) => {
    const at = o.intents.indexOf(hostileBoundary(kind));
    return { guard: hostileGuardId(kind), action: o.action, next: at < 0 ? null : (o.intents[at + 1] ?? null) };
  };

  // The one guard-boundary assertion both halves run: the guarded action succeeded and the
  // runner's genuine next intent followed it.
  function expectProgression(kind: HostileKind, o: HostileObservation) {
    expect(observedProgression(kind, o), `AC2 progression guard=${hostileGuardId(kind)}`).toEqual(progressionFor(kind));
  }

  // Intact RED is only that matcher's own failure at the refused boundary. Its success, or any
  // other error, fails the test.
  function expectIntactRed(kind: HostileKind, o: HostileObservation) {
    const guard = hostileGuardId(kind);
    let failure: unknown;
    try {
      expectProgression(kind, o);
    } catch (error) {
      failure = error;
    }
    const red = failure as { name?: unknown; message?: unknown; expected?: unknown; actual?: unknown } | undefined;
    expect(red?.name, `AC2 guard=${guard} RED error`).toBe("AssertionError");
    expect(String(red?.message).startsWith(`AC2 progression guard=${guard}: `), `AC2 guard=${guard} RED matcher`).toBe(
      true,
    );
    expect(red?.expected).toEqual(progressionFor(kind));
    expect(red?.actual).toEqual({
      guard,
      action: { intent: hostileBoundary(kind), status: 409, outcome: "capture-stopped" },
      next: null,
    });
    console.log(
      `AC2 guard=${guard} RED boundary=${hostileBoundary(kind)} expected=${JSON.stringify(red?.expected)} actual=${JSON.stringify(red?.actual)}`,
    );
  }

  async function runHostilePair(kind: HostileKind, mutant: HostileMutant) {
    const guard = hostileGuardId(kind);
    const intact = await observeHostile(kind);
    expect(hostileState(intact), `AC2 state guard=${guard} intact`).toEqual(hostileRows[kind].intact);
    expectIntactRed(kind, intact);

    await resetMultiContextTestSchemas(pools);
    const disabled = await observeHostile(kind, mutant);
    expect(hostileState(disabled), `AC2 state guard=${guard} disabled`).toEqual(hostileRows[kind].disabled);
    expectProgression(kind, disabled);
    console.log(
      `AC2 guard=${guard} GREEN boundary=${hostileBoundary(kind)} actual=${JSON.stringify(observedProgression(kind, disabled))}`,
    );
  }

  it("rejects unsafe lifecycle (replay)", async () => {
    expect(hostileState(await observeHostile("replay"))).toEqual(hostileRows.replay.intact);
  });
  it("rejects unsafe lifecycle (refresh)", async () => {
    expect(hostileState(await observeHostile("refresh"))).toEqual(hostileRows.refresh.intact);
  });
  it("rejects unsafe lifecycle (refused authority)", async () => {
    expect(hostileState(await observeHostile("refused-authority"))).toEqual(hostileRows["refused-authority"].intact);
  });
  it("rejects unsafe lifecycle (cap overflow)", async () => {
    expect(hostileState(await observeHostile("cap-overflow"))).toEqual(hostileRows["cap-overflow"].intact);
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
