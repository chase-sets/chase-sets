import { describe, expect, it } from "vitest";
import { CountCaptureStopped } from "../../source-observations/api/providers/count-capture-transport";
import {
  observeCountSourceWinners,
  type CountSourceWinner,
} from "../../source-observations/api/providers/count-capture-winners";
import { scrydexCountQuery } from "../../source-observations/api/providers/scrydex/adapter";
import type { ScrydexCountSource } from "../domain/count-acquisition";
import type { CountCaptureKind } from "../domain/count-capture-plan";
import {
  captureCountQuery,
  captureNow,
  completeCacheRecord,
  createCapturePlannerFixture,
  createCaptureReaderFixture,
  pageOneEvidence,
} from "../tests/count-capture-planner-fixture";
import { collectCountCapturePlannerRead } from "./count-capture-context";
import * as transport from "../../source-observations/api/providers/count-capture-transport";
import { sendCatalogProviderRequest } from "../../source-observations/api/providers/provider-send-admission";
import { guardDisabledMutant } from "../tests/count-capture-mutants";
import {
  captureAuthority,
  captureScope,
  captureSession,
  createCaptureLifecycleFixture,
} from "../tests/count-capture-session-fixture";
import { createCountCaptureLifecycle } from "./count-capture-lifecycle";
import { retainTargetedCountCaptureUsage } from "./count-capture-usage";

const kinds = ["cards", "sealed"] as const;
const later = (ms: number) => new Date(Date.parse(captureNow) + ms).toISOString();

async function observeRead(reader: ReturnType<typeof createCaptureReaderFixture>, kind: CountCaptureKind) {
  const winners: CountSourceWinner[] = [];
  const value = await observeCountSourceWinners(
    (winner) => winners.push(winner),
    () => reader.read(captureCountQuery(kind)),
  );
  return { value, winners };
}

describe("captures actual winners", () => {
  it("reports the reader's own selection and clock, with no extra lookup and nothing outside observation", async () => {
    const plain = createCaptureReaderFixture();
    const unobserved = await plain.read(captureCountQuery("cards"));
    const reader = createCaptureReaderFixture();
    const { value, winners } = await observeRead(reader, "cards");
    expect(value).toEqual(unobserved);
    expect(winners).toEqual([{ query: captureCountQuery("cards"), source: value, readAt: captureNow }]);
    expect(reader.countReader.read).toHaveBeenCalledTimes(plain.countReader.read.mock.calls.length);
    expect(reader.cacheStore.read).toHaveBeenCalledTimes(1);
    expect(reader.now).toHaveBeenCalledTimes(plain.now.mock.calls.length);
    const outside: CountSourceWinner[] = [];
    await observeCountSourceWinners(
      (winner) => outside.push(winner),
      async () => undefined,
    );
    await reader.read(captureCountQuery("sealed"));
    expect(outside).toEqual([]);
  });

  it.each([
    ["stale", { counts: { cards: pageOneEvidence("cards", { observedAt: later(-900_001) }) } }, null],
    ["future", { counts: { cards: pageOneEvidence("cards", { observedAt: later(1) }) } }, null],
    [
      "mismatched",
      {
        counts: {
          cards: pageOneEvidence("cards", {
            query: scrydexCountQuery({ ...captureCountQuery("cards"), parentValue: "OP02" }),
          }),
        },
      },
      null,
    ],
    ["absent", { counts: {} }, null],
    [
      "tied complete-cache",
      {
        counts: { cards: pageOneEvidence("cards", { observedAt: later(-60_000) }) },
        caches: { cards: completeCacheRecord("cards", later(-60_000)) },
      },
      "complete-cache",
    ],
    [
      "newer complete-cache",
      {
        counts: { cards: pageOneEvidence("cards", { observedAt: later(-120_000) }) },
        caches: { cards: completeCacheRecord("cards", later(-60_000)) },
      },
      "complete-cache",
    ],
    [
      "newer page-1 over complete-cache",
      {
        counts: { cards: pageOneEvidence("cards", { observedAt: later(-60_000) }) },
        caches: { cards: completeCacheRecord("cards", later(-120_000)) },
      },
      "page-1-count",
    ],
  ] as const)("reports a %s read as the reader selected it", async (_mode, fixture, validationKind) => {
    const { value, winners } = await observeRead(createCaptureReaderFixture(fixture), "cards");
    expect(value?.validationKind ?? null).toBe(validationKind);
    if (validationKind === "complete-cache") expect(value?.sourceId).toBe(fixture.caches?.cards?.cacheKey);
    expect(winners).toEqual([{ query: captureCountQuery("cards"), source: value, readAt: captureNow }]);
  });

  it("binds each consumed source to this read's one winner, leaving the plan and fingerprint unchanged", async () => {
    const reader = createCaptureReaderFixture();
    const { planner, input } = createCapturePlannerFixture((kind) => reader.read(captureCountQuery(kind)));
    const plain = await planner.resolve(input);
    const observation = await collectCountCapturePlannerRead(() => planner.resolve(input));
    expect(observation.value).toEqual(plain);
    expect(observation.value.preview.planFingerprint).toBe(plain.preview.planFingerprint);
    expect(observation.plan).toEqual(observation.value);
    expect(observation.winners).toEqual(
      kinds.map((kind) => ({ query: captureCountQuery(kind), source: pageOneEvidence(kind), readAt: captureNow })),
    );
    expect(reader.countReader.read).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["absent sources", { counts: {} }, [null, null]],
    [
      "a tied complete-cache winner",
      { caches: { cards: completeCacheRecord("cards", pageOneEvidence("cards").observedAt) } },
      ["complete-cache", "page-1-count"],
    ],
  ] as const)("records %s honestly rather than stopping", async (_mode, fixture, expected) => {
    const reader = createCaptureReaderFixture(fixture);
    const { planner, input } = createCapturePlannerFixture((kind) => reader.read(captureCountQuery(kind)));
    const observation = await collectCountCapturePlannerRead(() => planner.resolve(input));
    expect(observation.winners.map((winner) => winner.source?.validationKind ?? null)).toEqual(expected);
    const units = observation.plan.plans[0]!.participationPreview.units;
    expect(units.map((unit) => unit.estimate.countSource?.validationKind ?? null)).toEqual([null, ...expected]);
  });

  type Hostile = (
    reader: ReturnType<typeof createCaptureReaderFixture>,
    kind: CountCaptureKind,
  ) => Promise<ScrydexCountSource | null>;
  const hostile: Record<string, Hostile> = {
    // The plan names a source no reader selected in this request.
    "missing winner": async (reader, kind) =>
      kind === "cards" ? pageOneEvidence("cards") : reader.read(captureCountQuery(kind)),
    "duplicate winner": async (reader, kind) => {
      if (kind === "cards") await reader.read(captureCountQuery(kind));
      return reader.read(captureCountQuery(kind));
    },
    // A source this request selected but the plan did not consume.
    "extra winner": async (reader, kind) => {
      const source = await reader.read(captureCountQuery(kind));
      return kind === "sealed" ? null : source;
    },
    // Bypass mutant: a matcher on query and totals would accept another source.
    "same-total other source": async (reader, kind) => {
      const source = await reader.read(captureCountQuery(kind));
      return kind === "cards" && source ? { ...source, sourceId: "synthetic-same-total-alternate" } : source;
    },
    "query mismatch": async (reader, kind) => {
      if (kind === "sealed") return reader.read(captureCountQuery(kind));
      await reader.read(scrydexCountQuery({ ...captureCountQuery("cards"), profileVersion: "2026.06.23" }));
      return pageOneEvidence("cards");
    },
    // Every consumed source has its winner, plus a read no selected unit owns.
    "unowned winner": async (reader, kind) => {
      if (kind === "cards")
        await reader.read(scrydexCountQuery({ ...captureCountQuery(kind), profileVersion: "2026.06.23" }));
      return reader.read(captureCountQuery(kind));
    },
    "excess winners": async (reader, kind) => {
      for (const parentValue of ["OP02", "OP03", "OP04", "OP05", "OP06"])
        await reader.read(scrydexCountQuery({ ...captureCountQuery(kind), parentValue }));
      return reader.read(captureCountQuery(kind));
    },
  };
  it.each(Object.keys(hostile))("stops on a %s instead of inferring evidence", async (mode) => {
    const reader = createCaptureReaderFixture();
    const { planner, input } = createCapturePlannerFixture((kind) => hostile[mode]!(reader, kind));
    await expect(collectCountCapturePlannerRead(() => planner.resolve(input))).rejects.toThrow(CountCaptureStopped);
  });

  it("stops on a duplicate absent winner for a unit that consumed no source", async () => {
    const reader = createCaptureReaderFixture({ counts: {} });
    const { planner, input } = createCapturePlannerFixture(async (kind) => {
      if (kind === "cards") await reader.read(captureCountQuery(kind));
      return reader.read(captureCountQuery(kind));
    });
    await expect(collectCountCapturePlannerRead(() => planner.resolve(input))).rejects.toThrow(CountCaptureStopped);
  });

  it("stops a second planner request or a read without one", async () => {
    const reader = createCaptureReaderFixture();
    const { planner, input } = createCapturePlannerFixture((kind) => reader.read(captureCountQuery(kind)));
    await expect(
      collectCountCapturePlannerRead(async () => {
        await planner.resolve(input);
        return planner.resolve(input);
      }),
    ).rejects.toThrow(CountCaptureStopped);
    // Without count reads, only the plan count tells two planner requests from one.
    const unread = createCapturePlannerFixture(async () => null);
    await expect(collectCountCapturePlannerRead(() => unread.planner.resolve(unread.input))).resolves.toMatchObject({
      winners: [],
    });
    await expect(
      collectCountCapturePlannerRead(async () => {
        await unread.planner.resolve(unread.input);
        return unread.planner.resolve(unread.input);
      }),
    ).rejects.toThrow(CountCaptureStopped);
    await expect(collectCountCapturePlannerRead(() => reader.read(captureCountQuery("cards")))).rejects.toThrow(
      CountCaptureStopped,
    );
  });

  it("keeps concurrent observed reads apart and stops a nested one with its outer read", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = 0;
    const fixtures = ["first", "second"].map((label) => {
      const reader = createCaptureReaderFixture({
        counts: Object.fromEntries(
          kinds.map((kind) => [kind, pageOneEvidence(kind, { sourceId: `synthetic-${label}-${kind}-debit` })]),
        ),
      });
      return createCapturePlannerFixture(async (kind) => {
        const source = await reader.read(captureCountQuery(kind));
        if (++waiting === 2) release();
        await barrier;
        return source;
      });
    });
    const observations = await Promise.all(
      fixtures.map(({ planner, input }) => collectCountCapturePlannerRead(() => planner.resolve(input))),
    );
    expect(observations.map((observation) => observation.winners.map((winner) => winner.source?.sourceId))).toEqual([
      ["synthetic-first-cards-debit", "synthetic-first-sealed-debit"],
      ["synthetic-second-cards-debit", "synthetic-second-sealed-debit"],
    ]);

    const { planner, input } = fixtures[0]!;
    await expect(
      collectCountCapturePlannerRead(async () => {
        await collectCountCapturePlannerRead(() => planner.resolve(input)).catch(() => null);
        return planner.resolve(input);
      }),
    ).rejects.toThrow(CountCaptureStopped);
  });
});

describe("targeted usage observation", () => {
  // A run admitted, baselined and noticed, ready for its bootstrap phase.
  async function noticed(options: Parameters<typeof createCaptureLifecycleFixture>[0] = {}) {
    const f = createCaptureLifecycleFixture(options);
    await f.lifecycle.baseline(captureSession(), { scopeRecordId: captureScope, authority: captureAuthority() });
    await f.lifecycle.initialNotice(captureSession());
    return f;
  }
  const run = (f: ReturnType<typeof createCaptureLifecycleFixture>) =>
    f.memory.history.at(-1)!.payload as { status: string; sends: { phase: string; usage?: unknown }[] };

  it("retains targeted usage", async () => {
    const f = await noticed({ retained: null });
    const { usage } = await f.lifecycle.usage(captureSession());
    expect(usage).toMatchObject({ state: "persisted", required: 11, authority: { headroom: 30, allowed: true } });
    // Exactly one deployed adapter usage read, persisted by its own callback.
    expect(f.usage.getUsageSnapshot).toHaveBeenCalledOnce();
    expect(f.counts.retainUsage).toHaveBeenCalledOnce();
    expect(f.usage.fetch.mock.calls.map(([url]) => String(url))).toEqual(["https://api.scrydex.com/account/v1/usage"]);
    expect(run(f)).toMatchObject({ status: "open", sends: [{ phase: "bootstrap", usage: { purpose: "bootstrap" } }] });
  });

  it("skips the read when durable authority already covers the remaining run cap", async () => {
    const f = await noticed({ retained: 11 });
    await expect(f.lifecycle.usage(captureSession())).resolves.toMatchObject({ usage: { state: "skipped" } });
    expect(f.usage.getUsageSnapshot).not.toHaveBeenCalled();
    expect(f.usage.fetch).not.toHaveBeenCalled();
    expect(run(f)).toMatchObject({ status: "open", sends: [] });
  });

  it("stops when authority is still insufficient, keeping the possible send", async () => {
    const f = await noticed({ retained: 10, remaining: 10 });
    await expect(f.lifecycle.usage(captureSession())).rejects.toThrow(CountCaptureStopped);
    expect(f.usage.fetch).toHaveBeenCalledOnce();
    expect(run(f)).toMatchObject({ status: "stopped", sends: [{ phase: "bootstrap" }] });
  });

  it("never forces a refresh: a warm adapter observation is persisted without a send", async () => {
    const f = createCaptureLifecycleFixture({ retained: null });
    await f.usage.getUsageSnapshot();
    f.counts.forget();
    f.usage.fetch.mockClear();
    f.usage.getUsageSnapshot.mockClear();
    f.counts.retainUsage.mockClear();
    await f.lifecycle.baseline(captureSession(), { scopeRecordId: captureScope, authority: captureAuthority() });
    await f.lifecycle.initialNotice(captureSession());
    await expect(f.lifecycle.usage(captureSession())).resolves.toMatchObject({ usage: { state: "persisted" } });
    expect(f.usage.getUsageSnapshot).toHaveBeenCalledOnce();
    expect(f.counts.retainUsage).toHaveBeenCalledOnce();
    expect(f.usage.fetch).not.toHaveBeenCalled();
    expect(run(f)).toMatchObject({ status: "open", sends: [] });
  });

  it.each([
    [
      "a raw usage GET",
      (f: ReturnType<typeof createCaptureLifecycleFixture>) =>
        sendCatalogProviderRequest(
          "scrydex",
          f.usage.fetch,
          "https://api.scrydex.com/account/v1/usage",
          undefined,
          "usage",
        ),
      0,
    ],
    [
      "a second usage read",
      async (f: ReturnType<typeof createCaptureLifecycleFixture>) => {
        for (const _ of [1, 2])
          await transport.runCountCaptureUsage({ purpose: "bootstrap" }, () =>
            sendCatalogProviderRequest(
              "scrydex",
              f.usage.fetch,
              "https://api.scrydex.com/account/v1/usage",
              undefined,
              "usage",
            ),
          );
      },
      1,
    ],
  ] as const)("refuses %s in place of the one adapter observation", async (_name, observe, sends) => {
    const f = await noticed({ retained: null });
    const lifecycle = createCountCaptureLifecycle({ ...f.deps, observeUsage: () => observe(f) });
    await expect(lifecycle.usage(captureSession())).rejects.toThrow(CountCaptureStopped);
    expect(f.usage.fetch).toHaveBeenCalledTimes(sends);
    expect(run(f).status).toBe("stopped");
  });

  // Bypass mutants: a deleted persistence callback leaves durable authority unchanged,
  // and an authority read from the raw returned balance would accept it anyway.
  it("rejects the callback-deleted and raw-authority mutants", async () => {
    const deleted = await noticed({ retained: null, callback: false });
    await expect(deleted.lifecycle.usage(captureSession())).rejects.toThrow(CountCaptureStopped);
    expect(deleted.usage.fetch).toHaveBeenCalledOnce();
    expect(deleted.counts.retainUsage).not.toHaveBeenCalled();

    const rawAuthority = guardDisabledMutant<typeof retainTargetedCountCaptureUsage>(
      "../api/count-capture-usage.ts",
      [
        ["await deps.getUsageSnapshot();", "const observed = await deps.getUsageSnapshot();"],
        ["const after = await deps.authority();", "const after = rawAuthority(observed);"],
      ],
      "retainTargetedCountCaptureUsage",
      {
        ...transport,
        rawAuthority: (snapshot: { remainingCredits: number | null }) => ({
          fingerprint: "0".repeat(64),
          headroom: snapshot.remainingCredits,
          allowed: snapshot.remainingCredits !== null,
        }),
      },
    );
    const f = await noticed({ retained: null, callback: false });
    const authority = f.counts.authority;
    await expect(rawAuthority({ authority, getUsageSnapshot: f.usage.getUsageSnapshot }, 11)).resolves.toMatchObject({
      state: "persisted",
    });
    await expect(
      retainTargetedCountCaptureUsage({ authority, getUsageSnapshot: f.usage.getUsageSnapshot }, 11),
    ).rejects.toThrow(CountCaptureStopped);
  });
});
