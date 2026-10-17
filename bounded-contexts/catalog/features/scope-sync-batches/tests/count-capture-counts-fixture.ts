import { vi } from "vitest";
import { createCountCaptureLifecycle } from "../api/count-capture-lifecycle";
import { countFingerprint, type ScrydexCountEvidence } from "../domain/count-acquisition";
import {
  acquireScrydexPageOneCount,
  readScrydexCountSource,
} from "../../source-observations/api/providers/scrydex/adapter";
import {
  countCaptureTransport,
  runCountCaptureUsage,
} from "../../source-observations/api/providers/count-capture-transport";
import { countCaptureUnitKeys, countCaptureQuerySchema } from "../domain/count-capture-plan";
import { createScopeSyncBatchConfirmationCheck } from "../api/count-capture-planner";
import { createCountCaptureStore } from "../read-model/count-capture-store";
import {
  captureAt,
  captureAuthority,
  captureScope,
  captureSession,
  createCaptureLifecycleFixture,
} from "../tests/count-capture-session-fixture";
import {
  captureCountQuery,
  pageOneEvidence,
  createCapturePlannerFixture,
} from "../tests/count-capture-planner-fixture";

export function captureCountsFixture(
  factories: {
    store?: typeof createCountCaptureStore;
    lifecycle?: typeof createCountCaptureLifecycle;
    reused?: readonly ("cards" | "sealed")[];
  } = {},
) {
  const f = createCaptureLifecycleFixture();
  const store = factories.store ? factories.store(f.memory.pool, () => f.clock.now) : f.store;
  const sources: Partial<Record<"cards" | "sealed", ScrydexCountEvidence>> = {};
  const selection = { mode: "ids" as const, scopeRecordIds: [captureScope] };
  const budget = { creditedProviderRequestLimits: { scrydex: 10 } };
  const targets = (["cards", "sealed"] as const).map((kind) => ({
    scopeRecordId: captureScope,
    query: countCaptureQuerySchema.parse({ ...captureCountQuery(kind), accountRevision: "runtime" }),
    source: factories.reused?.includes(kind)
      ? {
          ...pageOneEvidence(kind),
          query: countCaptureQuerySchema.parse({ ...captureCountQuery(kind), accountRevision: "runtime" }),
          observedAt: captureAt,
        }
      : null,
    blocked: false,
  }));
  const value = {
    quoteId: "00000000-0000-4000-8000-000000000001",
    membershipFingerprint: "a".repeat(64),
    selection,
    authority: { fingerprint: countFingerprint({ remaining: 30, committed: 0 }), headroom: 30, allowed: true },
    targets,
    plannedCredits: 2 - (factories.reused?.length ?? 0),
    cap: 2 - (factories.reused?.length ?? 0),
    expiresAt: "2026-10-13T08:17:00.000Z",
    state: "quoted" as const,
  };
  const quote = { ...value, fingerprint: countFingerprint(value) };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    if (String(url).endsWith("/usage")) return Response.json({ synthetic: true });
    const total = String(url).includes("/sealed") ? 7 : 121;
    return Response.json({
      data: Array.from({ length: Math.min(100, total) }, (_, index) => ({ id: `synthetic-${index}` })),
      page: 1,
      page_size: 100,
      total_count: total,
    });
  });
  const planned = createCapturePlannerFixture((kind) =>
    readScrydexCountSource(
      { ...captureCountQuery(kind), accountRevision: "runtime" },
      {
        now: () => new Date(f.clock.now),
        countReader: { read: async (query) => sources[query.kind] ?? null },
      },
    ),
  );
  const planScope = planned.previewCatalogSyncScope.getMockImplementation()!;
  planned.previewCatalogSyncScope.mockImplementation(async (...args) => {
    if (args[0].acceptedScopeMappings?.length)
      for (const unitKey of countCaptureUnitKeys)
        await runCountCaptureUsage({ purpose: "planImport", unitKey }, () =>
          countCaptureTransport("scrydex", "usage", fetch)!("https://api.scrydex.com/account/v1/usage"),
        );
    return planScope(...args);
  });
  const confirmation = createScopeSyncBatchConfirmationCheck(planned.planner);
  const counts = {
    quoteCounts: vi.fn(async () => structuredClone(quote)),
    getCountQuote: vi.fn(async () =>
      structuredClone({ ...quote, state: quote.plannedCredits === 0 ? ("complete" as const) : quote.state }),
    ),
    acquireCounts: vi.fn(async () => {
      const acquired = [];
      for (const target of quote.targets) {
        if (target.source) {
          sources[target.query.kind] = target.source;
          acquired.push(target);
          continue;
        }
        await acquireScrydexPageOneCount(target.query, {
          fetch,
          now: () => new Date(captureAt),
          credentials: { apiKey: "synthetic-key", teamId: "synthetic-team" },
        });
        const source = {
          ...pageOneEvidence(target.query.kind),
          query: target.query,
          observedAt: captureAt,
          expiresAt: quote.expiresAt,
        };
        sources[target.query.kind] = source;
        acquired.push({ ...target, source });
      }
      return { ...quote, state: "complete" as const, targets: acquired };
    }),
    preview: vi.fn(async (input) => (await planned.planner.resolve(input)).preview),
    preConfirmPlannerRead: vi.fn(confirmation.preConfirmPlannerRead),
  };
  const readCountEvidence = vi.fn(async () => ({
    complete: true,
    acquisitions: Object.values(sources).map((evidence) => ({
      evidence: { ...evidence, query: countCaptureQuerySchema.parse(evidence.query) },
      debitId: evidence.sourceId,
      quoteId: quote.quoteId,
      kind: evidence.query.kind,
      debitedAt: captureAt,
      credits: 1 as const,
      outcome: "complete" as const,
      reused: false,
      priorReceiptHash: null,
      method: "GET" as const,
    })),
    usage: {
      bootstrap: "skipped" as const,
      creditState: "available" as const,
      totalCredits: 30,
      remainingCredits: 30,
      usedCredits: null,
      observedAt: captureAt,
      ageMs: 0,
      providerUpdatedAt: null,
      lagCategory: "documented-window" as const,
      unreflectedCredits: 0,
      reservedCredits: 0,
      additionalUsageCredits: 0,
      persisted: true,
    },
  }));
  const deps = { ...f.deps, store, counts, readCountEvidence };
  const lifecycle = (factories.lifecycle ?? createCountCaptureLifecycle)(deps);
  const ready = async () => {
    await lifecycle.baseline(captureSession(), { scopeRecordId: captureScope, authority: captureAuthority() });
    await lifecycle.initialNotice(captureSession());
    await lifecycle.usage(captureSession());
  };
  const run = () => f.memory.history.at(-1)!.payload as Awaited<ReturnType<typeof f.store.read>>;
  const acquire = async () => {
    await ready();
    const bound = await lifecycle.quote(captureSession(), { selection, budget });
    await lifecycle.quoteReadback(captureSession());
    await lifecycle.finalNotice(captureSession());
    await lifecycle.acquire(captureSession(), { quoteId: bound.quoteId, fingerprint: bound.fingerprint });
  };
  return {
    ...f,
    store,
    deps,
    sources,
    readCountEvidence,
    lifecycle,
    selection,
    budget,
    quote,
    writer: counts,
    fetch,
    ready,
    acquire,
    run,
  };
}
