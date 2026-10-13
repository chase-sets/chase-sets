import { describe, expect, it, vi } from "vitest";
import { buildScopeSyncBatchPreview, type ScopeSyncBatchPlannedScope } from "../domain/batch";
import { syntheticCountLifecycleReceipt } from "../tests/count-lifecycle-receipt-fixture";
import { countCaptureUnitKeys } from "../domain/count-lifecycle-receipt";
import { captureCountPlan, countCapturePlanSchema } from "../domain/count-capture-plan";
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
    mappingVersions: [{ mappingId: "synthetic-mapping", version: "2026-10-13T08:00:00Z", reviewStatus: "accepted" }],
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
        context: {
          tenantId: "tnt_synthetic",
          audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
        },
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
  it("retains the full observed roster, not selected units or the sampled public preview", () => {
    const { plan, sources } = fixture();
    const original = plan.plans[0]!;
    const first = original.participationPreview.units[0]!;
    const complete = {
      ...plan,
      preview: { ...plan.preview, samples: [] },
      plans: [
        {
          ...original,
          participationPreview: {
            ...original.participationPreview,
            units: [
              {
                ...first,
                unitKey: countCaptureUnitKeys[0],
                profileKey: "synthetic-set-profile",
                profileVersion: "synthetic-set-version",
                role: "reference-data" as const,
                selected: false,
                estimate: { ...first.estimate, countSource: null },
                explanation: "synthetic-secret-marker",
              },
              ...original.participationPreview.units,
            ],
          },
        },
      ],
    };
    const retained = captureCountPlan(complete);
    expect(retained.selection).toEqual(plan.preview.selection);
    expect(retained.budget).toEqual(plan.preview.budget);
    expect(retained.resolvedAt).toBe(plan.preview.resolvedAt);
    expect(retained.scopes[0]).toMatchObject({
      scopeRecordId: original.scopeRecordId,
      scopeRecordVersion: original.scopeRecordVersion,
      mappingVersions: original.mappingVersions,
      profileVersions: original.profileVersions,
      scope: original.scope,
    });
    expect(retained.scopes[0]!.units.map((unit) => unit.unitKey)).toEqual(countCaptureUnitKeys);
    expect(retained.scopes[0]!.units[0]).toMatchObject({
      selected: false,
      profileKey: "synthetic-set-profile",
      profileVersion: "synthetic-set-version",
      role: "reference-data",
    });
    expect(retained.scopes[0]!.units.slice(1).map((unit) => unit.estimate.countSourceId)).toEqual(
      sources.map((source) => source.sourceId),
    );
    expect(JSON.stringify(retained)).not.toContain("synthetic-secret-marker");
    expect(plan.preview.planFingerprint).toBe(complete.preview.planFingerprint);
  });
  it.each([
    "scope-date",
    "mapping-date",
    "nested-unknown",
    "out-of-range",
    "missing-budget",
    "missing-roster",
    "duplicate-unit",
    "duplicate-profile",
    "profile-mismatch",
    "extra-provider",
    "extra-scope",
  ])("rejects an unsafe retained plan: %s", (mode) => {
    const value = captureCountPlan(fixture().plan);
    const scope = value.scopes[0]!;
    if (mode === "scope-date") scope.scopeRecordVersion = "2026-10-13";
    if (mode === "mapping-date") scope.mappingVersions[0]!.version = "2026-10-13";
    if (mode === "nested-unknown") Object.assign(scope.units[0]!.estimate, { rawBody: "synthetic-secret" });
    if (mode === "out-of-range") scope.units[0]!.estimate.targetCount = 2147483648;
    if (mode === "missing-budget") Reflect.deleteProperty(value, "budget");
    if (mode === "missing-roster") Reflect.deleteProperty(scope, "units");
    if (mode === "duplicate-unit") scope.units[1] = scope.units[0]!;
    if (mode === "duplicate-profile") scope.profileVersions[1] = scope.profileVersions[0]!;
    if (mode === "profile-mismatch") scope.profileVersions[0]!.profileVersion = "different";
    if (mode === "extra-provider") Object.assign(value.budget.providerConcurrency, { other: 1 });
    if (mode === "extra-scope") value.scopes.push(scope);
    expect(countCapturePlanSchema.safeParse(value).success).toBe(false);
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
