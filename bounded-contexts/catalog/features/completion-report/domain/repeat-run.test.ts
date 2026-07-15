import { describe, expect, it } from "vitest";
import { reconcileRepeatRun } from "./repeat-run";
import { completeManifest } from "./__fixtures__/manifest";

describe("reconcileRepeatRun", () => {
  it("converges when a repeat run reproduces the accepted manifest exactly", () => {
    const accepted = completeManifest();
    const repeat = { ...completeManifest(), batch: { ...accepted.batch, batchId: "batch-2" } };
    const result = reconcileRepeatRun(accepted, repeat);
    expect(result.convergent).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("detects a changed plan fingerprint", () => {
    const accepted = completeManifest();
    const repeat = { ...completeManifest(), batch: { ...accepted.batch, planFingerprint: "fp-2" } };
    const result = reconcileRepeatRun(accepted, repeat);
    expect(result.convergent).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain("plan-fingerprint-changed");
  });

  it("detects duplicate Catalog truth when a repeat run mints new published items", () => {
    const accepted = completeManifest();
    const repeat = {
      ...completeManifest(),
      catalogItems: { draft: 0, published: 105 },
      promotions: { create: 6, update: 0, ignore: 0, defer: 0 },
      sourceObservations: { ...accepted.sourceObservations, promoted: 105 },
    };
    const result = reconcileRepeatRun(accepted, repeat);
    expect(result.findings.map((finding) => finding.code)).toContain("duplicate-catalog-truth");
    expect(result.deltas.catalogItemPublishedDelta).toBe(5);
  });

  it("detects unexpected new planned work", () => {
    const accepted = completeManifest();
    const repeat = {
      ...completeManifest(),
      expectedUnits: [
        ...accepted.expectedUnits,
        { scopeRecordId: "scope-2", providerKey: "scrydex", unitKey: "cards" },
      ],
    };
    const result = reconcileRepeatRun(accepted, repeat);
    expect(result.findings.map((finding) => finding.code)).toContain("unexpected-work");
    expect(result.deltas.newlyIntroducedUnitCount).toBe(1);
  });
});
