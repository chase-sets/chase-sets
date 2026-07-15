import { describe, expect, it } from "vitest";
import { completionExitCode, reconcileProductionCatalogCompletion } from "./reconcile";
import type { ProductionCatalogCompletionManifest } from "./manifest";
import { completeManifest, fixtureAfterCutoff, fixtureBeforeCutoff } from "./__fixtures__/manifest";

const generatedAt = "2026-08-03T00:00:00.000Z";

function reconcile(manifest: ProductionCatalogCompletionManifest) {
  return reconcileProductionCatalogCompletion(manifest, { generatedAt });
}

describe("reconcileProductionCatalogCompletion", () => {
  it("reports a complete manifest as 100% terminal coverage with no blockers", () => {
    const report = reconcile(completeManifest());
    expect(report.result).toBe("complete");
    expect(report.blockers).toEqual([]);
    expect(report.coverage.providerUnitCoverageRatio).toBe(1);
    expect(report.coverage.scopeCoverageRatio).toBe(1);
    expect(report.coverage.terminalProviderUnitCount).toBe(1);
    expect(completionExitCode(report)).toBe(0);
  });

  it("is deterministic: reconciling the same manifest twice yields identical reports", () => {
    const manifest = completeManifest();
    expect(reconcile(manifest)).toEqual(reconcile(manifest));
  });

  it("fails deterministically when an accepted provider mapping is missing", () => {
    const manifest = completeManifest();
    const report = reconcile({ ...manifest, scopes: [{ ...manifest.scopes[0], acceptedMappings: [] }] });
    expect(report.result).toBe("incomplete");
    expect(report.blockers.map((blocker) => blocker.code)).toContain("mapping-missing");
    expect(completionExitCode(report)).toBe(2);
  });

  it("fails on a never-synced required unit", () => {
    const manifest = completeManifest();
    const report = reconcile({ ...manifest, observedUnits: [] });
    expect(report.blockers.map((blocker) => blocker.code)).toContain("never-synced-unit");
    expect(report.blockers.map((blocker) => blocker.code)).toContain("incomplete-coverage");
  });

  it("fails on a failed sync job", () => {
    const manifest = completeManifest();
    const report = reconcile({
      ...manifest,
      observedUnits: [{ ...manifest.observedUnits[0], state: "failed", failedCount: 2 }],
    });
    expect(report.blockers.map((blocker) => blocker.code)).toContain("failed-job");
  });

  it("fails on a stale sync job", () => {
    const manifest = completeManifest();
    const report = reconcile({
      ...manifest,
      observedUnits: [{ ...manifest.observedUnits[0], state: "stale" }],
    });
    expect(report.blockers.map((blocker) => blocker.code)).toContain("stale-job");
  });

  it("fails when terminal coverage settled before the launch cutoff", () => {
    const manifest = completeManifest();
    const report = reconcile({
      ...manifest,
      observedUnits: [{ ...manifest.observedUnits[0], lastCompletedAt: fixtureBeforeCutoff }],
    });
    expect(report.blockers.map((blocker) => blocker.code)).toContain("pre-cutoff-coverage");
  });

  it("fails on a non-terminal (running) required unit", () => {
    const manifest = completeManifest();
    const report = reconcile({
      ...manifest,
      observedUnits: [{ ...manifest.observedUnits[0], state: "running", lastCompletedAt: null }],
    });
    expect(report.blockers.map((blocker) => blocker.code)).toContain("non-terminal-unit");
  });

  it("excludes validation-only provider units and never counts them as required coverage", () => {
    const manifest = completeManifest();
    const withValidationUnit: ProductionCatalogCompletionManifest = {
      ...manifest,
      scopes: [
        {
          ...manifest.scopes[0],
          acceptedMappings: [
            { providerKey: "scrydex", unitKey: "cards" },
            { providerKey: "tcgdex", unitKey: "sealed" },
          ],
        },
      ],
      expectedUnits: [
        { scopeRecordId: "scope-1", providerKey: "scrydex", unitKey: "cards" },
        { scopeRecordId: "scope-1", providerKey: "tcgdex", unitKey: "sealed" },
      ],
    };
    const report = reconcile(withValidationUnit);
    expect(report.result).toBe("complete");
    expect(report.coverage.requiredProviderUnitCount).toBe(1);
    expect(report.exclusions).toContainEqual({ reason: "validation-only", count: 1 });
  });

  it("excludes ineligible scopes with the ineligible reason", () => {
    const manifest = completeManifest();
    const report = reconcile({ ...manifest, scopes: [{ ...manifest.scopes[0], eligible: false }] });
    expect(report.coverage.requiredProviderUnitCount).toBe(0);
    expect(report.exclusions).toContainEqual({ reason: "ineligible", count: 1 });
    expect(report.result).toBe("complete");
  });

  it("treats an explicit operator-deferred exclusion as explained, not a blocker", () => {
    const manifest = completeManifest();
    const report = reconcile({
      ...manifest,
      observedUnits: [],
      exclusions: [
        { scopeRecordId: "scope-1", providerKey: "scrydex", unitKey: "cards", reason: "operator-deferred", note: null },
      ],
    });
    expect(report.result).toBe("complete");
    expect(report.exclusions).toContainEqual({ reason: "operator-deferred", count: 1 });
  });

  it("flags an unresolved merge candidate as a blocker without an explicit disposition", () => {
    const manifest = completeManifest();
    const report = reconcile({
      ...manifest,
      mergeCandidates: [{ ...manifest.mergeCandidates[0], status: "ready" }],
    });
    expect(report.mergeCandidates.unresolved).toBe(1);
    expect(report.blockers.map((blocker) => blocker.code)).toContain("unresolved-merge-candidate");
  });

  it("fails on blocking merge conflicts and duplicate-prevention blocks", () => {
    const manifest = completeManifest();
    const report = reconcile({
      ...manifest,
      mergeCandidates: [
        {
          candidateId: "cand-2",
          scopeRecordId: "scope-1",
          status: "has-conflicts",
          blockingConflictCount: 2,
          duplicatePreventionBlocked: true,
        },
      ],
    });
    const codes = report.blockers.map((blocker) => blocker.code);
    expect(codes).toContain("blocked-promotion");
    expect(codes).toContain("duplicate-prevention-block");
    expect(report.mergeCandidates.unresolvedConflicts).toBe(2);
    expect(report.mergeCandidates.duplicatePreventionBlocks).toBe(1);
  });

  it("fails on approved-provider asset processing failures", () => {
    const manifest = completeManifest();
    const report = reconcile({ ...manifest, assetProcessing: { approvedFailures: 3, exclusions: 0 } });
    expect(report.blockers.map((blocker) => blocker.code)).toContain("asset-processing-failure");
  });

  it("fails when credited provider usage is unavailable", () => {
    const manifest = completeManifest();
    const report = reconcile({
      ...manifest,
      providerUsage: [{ ...manifest.providerUsage[0], usageCheckState: "unavailable" }],
    });
    expect(report.blockers.map((blocker) => blocker.code)).toContain("credited-usage-unavailable");
  });

  it("flags an unattributable exclusion as unexplained", () => {
    const manifest = completeManifest();
    const report = reconcile({
      ...manifest,
      exclusions: [{ scopeRecordId: null, providerKey: null, unitKey: null, reason: "rollout-blocked", note: "n/a" }],
    });
    expect(report.blockers.map((blocker) => blocker.code)).toContain("unexplained-exclusion");
  });

  it("orders blockers stably regardless of input order", () => {
    const manifest = completeManifest();
    const scrambled = reconcile({
      ...manifest,
      observedUnits: [],
      assetProcessing: { approvedFailures: 1, exclusions: 0 },
      mergeCandidates: [{ ...manifest.mergeCandidates[0], status: "ready" }],
    });
    const codes = scrambled.blockers.map((blocker) => blocker.code);
    expect(codes).toEqual([...codes].sort());
  });

  it("keeps coverage after the cutoff current when settled exactly at the cutoff boundary", () => {
    const manifest = completeManifest();
    const report = reconcile({
      ...manifest,
      observedUnits: [{ ...manifest.observedUnits[0], lastCompletedAt: fixtureAfterCutoff }],
    });
    expect(report.result).toBe("complete");
  });
});
