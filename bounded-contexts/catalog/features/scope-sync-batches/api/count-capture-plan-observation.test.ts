import { describe, expect, it } from "vitest";
import {
  captureCountPlannerRead,
  countCapturePlannerReadSchema,
  countCaptureUnitKeys,
  type CountCapturePlannerRead,
} from "../domain/count-capture-plan";
import {
  captureCountQuery,
  captureNow,
  completeCacheRecord,
  createCapturePlannerFixture,
  createCaptureReaderFixture,
  pageOneEvidence,
} from "../tests/count-capture-planner-fixture";
import { collectCountCapturePlannerRead } from "./count-capture-context";
import { createScopeSyncBatchConfirmationCheck } from "./count-capture-planner";

function fixture(reader = createCaptureReaderFixture()) {
  const planned = createCapturePlannerFixture((kind) => reader.read(captureCountQuery(kind)));
  return { ...planned, checks: createScopeSyncBatchConfirmationCheck(planned.planner) };
}

async function observedRows(
  f: ReturnType<typeof fixture>,
  budget: { creditedProviderRequestLimits: { scrydex: number } } = f.input.budget,
  compare?: string,
) {
  const input = { ...f.input, budget };
  const preview = await collectCountCapturePlannerRead(() => f.planner.resolve(input));
  const planFingerprint = compare ?? preview.value.preview.planFingerprint;
  const preConfirm = await collectCountCapturePlannerRead(() =>
    f.checks.preConfirmPlannerRead({ ...input, planFingerprint }),
  );
  return [
    captureCountPlannerRead({
      requestId: "synthetic-preview-request",
      plan: preview.plan,
      winners: preview.winners,
      preConfirm: null,
    }),
    captureCountPlannerRead({
      requestId: "synthetic-pre-confirm-request",
      plan: preConfirm.plan,
      winners: preConfirm.winners,
      preConfirm: preConfirm.value,
    }),
  ] as const;
}

const accepted = (row: CountCapturePlannerRead) => countCapturePlannerReadSchema.safeParse(row).success;

describe("projects observed planner reads into planner-read rows", () => {
  it("keeps the unit roster, estimates, consumed sources and read times of both reads", async () => {
    const [preview, preConfirm] = await observedRows(fixture());
    expect(accepted(preview) && accepted(preConfirm)).toBe(true);
    expect(preview).toMatchObject({ phase: "preview", comparedFingerprint: null, eligible: true, refusal: null });
    expect(preConfirm).toMatchObject({
      phase: "pre-confirm",
      comparedFingerprint: preview.planFingerprint,
      planFingerprint: preview.planFingerprint,
      eligible: true,
      refusal: null,
      effectsCapability: false,
    });
    for (const row of [preview, preConfirm]) {
      const units = row.plan.scopes[0]!.units;
      expect(units.map((unit) => unit.unitKey)).toEqual(countCaptureUnitKeys);
      expect(units.map((unit) => unit.estimate.countSourceId)).toEqual([
        null,
        "synthetic-cards-debit",
        "synthetic-sealed-debit",
      ]);
      expect(units.map((unit) => [unit.estimate.targetCount, unit.estimate.estimatedRequestCount])).toEqual([
        [null, 1],
        [121, 2],
        [7, 1],
      ]);
      expect(row.winners).toEqual(
        (["cards", "sealed"] as const).map((kind) => ({
          kind,
          query: captureCountQuery(kind),
          source: pageOneEvidence(kind),
          readAt: captureNow,
        })),
      );
      expect(row.plan.resolvedAt).toBe(captureNow);
      expect(JSON.stringify(row)).not.toContain("synthetic-explanation-marker");
    }
  });

  it("projects blocked and stale confirmation refusals with their codes", async () => {
    const [blockedPreview, blocked] = await observedRows(fixture(), { creditedProviderRequestLimits: { scrydex: 1 } });
    expect(blockedPreview).toMatchObject({ eligible: false, refusal: "scope-sync-batch-blocked" });
    expect(blocked).toMatchObject({ eligible: false, refusal: "scope-sync-batch-blocked" });
    const [, stale] = await observedRows(fixture(), undefined, "0".repeat(64));
    expect(stale).toMatchObject({
      comparedFingerprint: "0".repeat(64),
      eligible: false,
      refusal: "scope-sync-batch-stale-preview",
    });
    expect([blockedPreview, blocked, stale].every(accepted)).toBe(true);
  });

  it("labels a complete-cache winner complete-cache, without page-1 facts", async () => {
    const [preview] = await observedRows(
      fixture(
        createCaptureReaderFixture({
          caches: { cards: completeCacheRecord("cards", pageOneEvidence("cards").observedAt) },
        }),
      ),
    );
    const cards = preview.winners.find((winner) => winner.kind === "cards")!;
    expect(cards.source).toMatchObject({ validationKind: "complete-cache", totalCount: 121, pageSize: 100 });
    expect(cards.source).not.toHaveProperty("returnedPage");
    expect(preview.plan.scopes[0]!.units[1]!.estimate.countSourceId).toBe(cards.source!.sourceId);
    expect(accepted(preview)).toBe(true);
  });

  it("refuses a check from another plan and a read outside the capture vocabulary", async () => {
    const f = fixture();
    const observation = await collectCountCapturePlannerRead(() => f.planner.resolve(f.input));
    const fingerprint = observation.plan.preview.planFingerprint;
    expect(() =>
      captureCountPlannerRead({
        requestId: "synthetic-pre-confirm-request",
        plan: observation.plan,
        winners: observation.winners,
        preConfirm: {
          comparedFingerprint: fingerprint,
          currentFingerprint: "1".repeat(64),
          eligible: true,
          refusal: null,
        },
      }),
    ).toThrow("did not resolve this plan");
    expect(() =>
      captureCountPlannerRead({
        requestId: "synthetic-preview-request",
        plan: observation.plan,
        winners: observation.winners.map((winner) => ({
          ...winner,
          query: { ...winner.query, environment: "runtime" },
        })),
        preConfirm: null,
      }),
    ).toThrow();
  });
});
