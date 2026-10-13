import { describe, expect, it, vi } from "vitest";
import { buildScopeSyncBatchPreview, type ScopeSyncBatchPlannedScope } from "../domain/batch";
import { syntheticCountLifecycleReceipt } from "../tests/count-lifecycle-receipt-fixture";
import { countCaptureUnitKeys } from "../domain/count-lifecycle-receipt";
import {
  collectCountCapturePlannerRead,
  observeCountCapturePlan,
  observeCountCaptureWinner,
} from "./count-capture-context";
import { createScopeSyncBatchPlanner } from "./planner";

function fixture() {
  const receipt = syntheticCountLifecycleReceipt();
  const sources = receipt.acquisitions.map((entry) => entry.evidence);
  const scope = {
    scopeVersion: "catalog-sync-scope-v2" as const,
    productDomain: "one-piece",
    languageCode: "en",
    reference: { kind: "set" as const, scopeRecordId: "synthetic-scope" },
  };
  const planned: ScopeSyncBatchPlannedScope = {
    scopeRecordId: "synthetic-scope",
    scopeRecordVersion: "2026-10-13T08:00:00Z",
    mappingVersions: [],
    profileVersions: sources.map((source) => ({
      providerKey: "scrydex",
      unitKey: source.query.unitKey,
      profileKey: source.query.profileKey,
      profileVersion: source.query.profileVersion,
    })),
    providerKeys: ["scrydex"],
    providerUnitCount: 2,
    estimatedRequestCount: 3,
    creditedProviderRequestEstimates: { scrydex: 3 },
    scope,
    participationPreview: {
      previewVersion: "catalog-sync-provider-participation-preview-v1",
      scope,
      status: "ready",
      startAllowed: true,
      units: sources.map((source) => ({
        providerKey: "scrydex",
        unitKey: countCaptureUnitKeys[source.query.kind === "cards" ? 1 : 2],
        profileKey: source.query.profileKey,
        profileVersion: source.query.profileVersion,
        displayName: "Synthetic source",
        role: "primary-source-observation",
        requirement: "required",
        eligibility: "eligible",
        defaultSelected: true,
        selected: true,
        childExecutionScope: null,
        estimate: {
          countSource: source,
          targetCount: source.totalCount,
          requestStrategy: "bulk-first",
          estimatedRequestCount: Math.max(1, Math.ceil(source.totalCount / source.pageSize)),
          estimateState: "estimated",
          estimateReason: null,
          usageCheckState: "checked",
          transportSteps: [],
        },
        blockers: [],
        explanation: "synthetic",
      })),
      estimate: {
        totalEstimatedRequestCount: 3,
        estimateState: "estimated",
        estimateReason: null,
        creditConsumingProviders: [],
      },
      blockers: [],
      explanation: "synthetic",
    },
    blockers: [],
  };
  const plan = {
    plans: [planned],
    preview: buildScopeSyncBatchPreview({
      selection: { mode: "ids", scopeRecordIds: ["synthetic-scope"] },
      plans: [planned],
      resolvedAt: "2026-10-13T08:04:10Z",
    }),
  };
  return { sources, plan };
}

describe("captures actual winners in the same planner result", () => {
  it("captures the actual resolver's empty blocked result without a second resolve", async () => {
    const query = vi.fn(async () => {
      throw new Error("empty selection must not query");
    });
    const planner = createScopeSyncBatchPlanner({ db: { query }, previewCatalogSyncScope: vi.fn() });
    const observation = await collectCountCapturePlannerRead(() =>
      planner.resolve({
        selection: { mode: "ids", scopeRecordIds: [] },
        context: { tenantId: "synthetic", audit: { performedByUserId: "synthetic", forAccountId: "synthetic" } },
      }),
    );
    expect(observation.plan).toEqual(observation.value);
    expect(observation.plan.preview.confirmAllowed).toBe(false);
    expect(observation.winners).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
  it("joins both exact sources to the actual fingerprinted plan, preserving read times", async () => {
    const { sources, plan } = fixture();
    const observation = await collectCountCapturePlannerRead(async () => {
      sources.forEach((source) => observeCountCaptureWinner(source.query, source, "2026-10-13T08:04:10Z"));
      observeCountCapturePlan(plan);
      return plan.preview;
    });
    expect(observation.plan.preview).toEqual(observation.value);
    expect(observation.winners.map((winner) => winner.source?.sourceId)).toEqual(
      sources.map((source) => source.sourceId),
    );
    expect(observation.winners.every((winner) => winner.readAt === "2026-10-13T08:04:10Z")).toBe(true);
  });
  it.each([
    "missing-plan",
    "double-plan",
    "missing-winner",
    "double-winner",
    "same-total-source",
    "query-mismatch",
    "unselected-source",
    "discarded-plan-source",
  ])("refuses %s instead of inferring evidence from totals", async (mode) => {
    const { sources, plan } = fixture();
    if (mode === "discarded-plan-source")
      Reflect.deleteProperty(plan.plans[0]!.participationPreview.units[0]!.estimate, "countSource");
    await expect(
      collectCountCapturePlannerRead(async () => {
        if (mode !== "missing-winner")
          for (const source of sources) {
            observeCountCaptureWinner(
              mode === "query-mismatch" ? { ...source.query, profileVersion: "another" } : source.query,
              mode === "same-total-source" ? { ...source, sourceId: "synthetic-alternate" } : source,
              "2026-10-13T08:04:10Z",
            );
          }
        if (mode === "double-winner") observeCountCaptureWinner(sources[0]!.query, sources[0]!, "2026-10-13T08:04:10Z");
        if (mode === "unselected-source")
          observeCountCaptureWinner(
            { ...sources[0]!.query, unitKey: "synthetic-other-unit" },
            null,
            "2026-10-13T08:04:10Z",
          );
        if (mode !== "missing-plan") observeCountCapturePlan(plan);
        if (mode === "double-plan") observeCountCapturePlan(plan);
        return plan.preview;
      }),
    ).rejects.toThrow("capture-stopped");
  });
});
