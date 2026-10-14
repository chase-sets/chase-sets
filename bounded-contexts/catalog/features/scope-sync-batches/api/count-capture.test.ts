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
