import { describe, expect, it } from "vitest";
import {
  assertScopeSyncBatchPreviewCurrent,
  buildScopeSyncBatchPreview,
  normalizeScopeSyncBatchBudget,
  providerConcurrencyAvailable,
  scopeSyncBatchStatusFromUnits,
  ScopeSyncBatchBlockedPreviewError,
  ScopeSyncBatchStalePreviewError,
  type ScopeSyncBatchPlannedScope,
} from "./batch";

function plan(overrides: Partial<ScopeSyncBatchPlannedScope> = {}): ScopeSyncBatchPlannedScope {
  return {
    scopeRecordId: "scope-1",
    scopeRecordVersion: "2026-07-14T00:00:00.000Z",
    mappingVersions: [{ mappingId: "mapping-1", version: "v1", reviewStatus: "accepted" }],
    profileVersions: [
      {
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        profileKey: "p",
        profileVersion: "1",
      },
    ],
    providerKeys: ["tcgdex"],
    providerUnitCount: 1,
    estimatedRequestCount: 1,
    creditedProviderRequestEstimates: {},
    scope: {
      scopeVersion: "catalog-sync-scope-v1",
      productDomain: "pokemon",
      languageCode: "en",
      reference: { kind: "expansion", id: "base", name: "Base Set" },
    },
    participationPreview: {
      previewVersion: "catalog-sync-provider-participation-preview-v1",
      scope: {
        scopeVersion: "catalog-sync-scope-v1",
        productDomain: "pokemon",
        languageCode: "en",
        reference: { kind: "expansion", id: "base", name: "Base Set" },
      },
      status: "ready",
      startAllowed: true,
      units: [],
      estimate: {
        totalEstimatedRequestCount: 1,
        estimateState: "estimated",
        estimateReason: null,
        creditConsumingProviders: [],
      },
      blockers: [],
      explanation: "ready",
    },
    blockers: [],
    ...overrides,
  };
}

describe("Scope Sync Batch", () => {
  it("returns a bounded empty preview and closes confirmation", () => {
    const preview = buildScopeSyncBatchPreview({
      selection: { mode: "matching-scope", query: { productDomain: "pokemon" } },
      plans: [],
      resolvedAt: "2026-07-14T00:00:00.000Z",
    });
    expect(preview.status).toBe("empty");
    expect(preview.confirmAllowed).toBe(false);
    expect(preview.blockers[0]?.code).toBe("empty-selection");
  });

  it("fingerprints scope, mapping, profile, rollout/cost plan, selection, and budgets", () => {
    const first = buildScopeSyncBatchPreview({
      selection: { mode: "ids", scopeRecordIds: ["scope-1"] },
      budget: { creditedProviderRequestLimits: { scrydex: 10 } },
      plans: [plan()],
      resolvedAt: "2026-07-14T00:00:00.000Z",
    });
    const changed = buildScopeSyncBatchPreview({
      selection: { mode: "ids", scopeRecordIds: ["scope-1"] },
      budget: { creditedProviderRequestLimits: { scrydex: 10 } },
      plans: [plan({ mappingVersions: [{ mappingId: "mapping-1", version: "v2", reviewStatus: "accepted" }] })],
      resolvedAt: "2026-07-14T00:01:00.000Z",
    });
    expect(changed.planFingerprint).not.toBe(first.planFingerprint);
    expect(() => assertScopeSyncBatchPreviewCurrent(first.planFingerprint, changed)).toThrow(
      ScopeSyncBatchStalePreviewError,
    );
  });

  it("fails closed for unavailable or over-limit credited provider evidence", () => {
    const preview = buildScopeSyncBatchPreview({
      selection: { mode: "ids", scopeRecordIds: ["scope-1"] },
      budget: { creditedProviderRequestLimits: { scrydex: 1 } },
      plans: [
        plan({
          providerKeys: ["scrydex"],
          creditedProviderRequestEstimates: { scrydex: 2 },
        }),
      ],
      resolvedAt: "2026-07-14T00:00:00.000Z",
    });
    expect(preview.blockers.map((blocker) => blocker.code)).toContain("credited-provider-budget-exceeded");
    expect(() => assertScopeSyncBatchPreviewCurrent(preview.planFingerprint, preview)).toThrow(
      ScopeSyncBatchBlockedPreviewError,
    );
  });

  it("keeps provider concurrency and credited-provider limits independently configurable", () => {
    const budget = normalizeScopeSyncBatchBudget({
      defaultProviderConcurrency: 4,
      providerConcurrency: { scrydex: 1 },
      providerRequestLimits: { scrydex: 75 },
      creditedProviderRequestLimits: { scrydex: 50 },
    });
    expect(budget.providerRequestLimits.scrydex).toBe(75);
    expect(budget.creditedProviderRequestLimits.scrydex).toBe(50);
    expect(providerConcurrencyAvailable({ providerKeys: ["scrydex"], activeByProvider: { scrydex: 1 }, budget })).toBe(
      false,
    );
    expect(providerConcurrencyAvailable({ providerKeys: ["tcgdex"], activeByProvider: { tcgdex: 3 }, budget })).toBe(
      true,
    );
  });

  it("blocks a provider independently when its estimated requests exceed the rate budget", () => {
    const base = plan();
    const preview = buildScopeSyncBatchPreview({
      selection: { mode: "ids", scopeRecordIds: ["scope-1"] },
      budget: { providerRequestLimits: { tcgdex: 1 } },
      plans: [
        plan({
          participationPreview: {
            ...base.participationPreview,
            units: [
              {
                providerKey: "tcgdex",
                unitKey: "tcgdex:pokemon:single-card:source-observation-import",
                profileKey: "p",
                profileVersion: "1",
                displayName: "TCGdex",
                role: "primary-source-observation",
                requirement: "required",
                eligibility: "eligible",
                defaultSelected: true,
                selected: true,
                childExecutionScope: {},
                estimate: {
                  targetCount: 2,
                  requestStrategy: "bulk-first",
                  estimatedRequestCount: 2,
                  estimateState: "estimated",
                  estimateReason: null,
                  transportSteps: [],
                },
                blockers: [],
                explanation: "ready",
              },
            ],
          },
        }),
      ],
      resolvedAt: "2026-07-14T00:00:00.000Z",
    });

    expect(preview.blockers.map((blocker) => blocker.code)).toContain("provider-request-budget-exceeded");
  });

  it("derives monotonic terminal batch status without losing successful units", () => {
    expect(scopeSyncBatchStatusFromUnits(["completed", "running", "queued"])).toBe("running");
    expect(scopeSyncBatchStatusFromUnits(["completed", "failed"])).toBe("partial");
    expect(scopeSyncBatchStatusFromUnits(["completed", "completed"])).toBe("completed");
  });
});
