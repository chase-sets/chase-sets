import { describe, expect, it } from "vitest";
import { mapChannelDriftToHealthObservation, mapPersistentGapToHealthObservation } from "../domain/health";
import type { ChannelDriftClassification, ChannelSourceAuthority } from "../domain/contracts";

const base = {
  connectionId: "connection-1",
  runGeneration: 5,
  sourceAttempt: 2,
  resultOrdinal: 1,
  policyRevision: 3,
  evaluationGeneration: 4,
  materialFingerprint: "material-fingerprint",
  occurredAt: "2026-09-12T06:00:00.000Z",
} as const;

describe("channel-reconciliation-health-outcome-table", () => {
  it.each([
    ["in-sync", { kind: "complete", collectedCount: 1, authorityTotal: 1 }, "success"],
    ["repairable", { kind: "complete", collectedCount: 1, authorityTotal: 1 }, "failure"],
    ["foreign-edit", { kind: "complete", collectedCount: 1, authorityTotal: 1 }, "failure"],
    ["structural", { kind: "complete", collectedCount: 1, authorityTotal: 1 }, "failure"],
    ["source-unavailable", { kind: "declared-incomplete", reason: "count-mismatch" }, "failure"],
  ] as const)("maps %s to %s", (classification, sourceAuthority, outcome) => {
    expect(
      mapChannelDriftToHealthObservation({
        ...base,
        classification: classification as ChannelDriftClassification,
        sourceAuthority: sourceAuthority as ChannelSourceAuthority,
      }),
    ).toMatchObject({ outcome, reasonCode: "drift", sourceAttempt: 2, resultOrdinal: 1 });
  });

  it.each(["claimed-snapshot-not-installed", "reconciliation-capability-unregistered"] as const)(
    "emits no failure for absent-by-design %s",
    (reason) => {
      expect(
        mapChannelDriftToHealthObservation({
          ...base,
          classification: "source-unavailable",
          sourceAuthority: { kind: "absent-by-design", reason },
        }),
      ).toBeNull();
    },
  );

  it("keeps attempt out of sourceWorkId and emits a distinct persistent-gap lineage", () => {
    const first = mapChannelDriftToHealthObservation({
      ...base,
      classification: "foreign-edit",
      sourceAuthority: { kind: "complete", collectedCount: 1, authorityTotal: 1 },
    })!;
    const retry = mapChannelDriftToHealthObservation({
      ...base,
      sourceAttempt: 3,
      classification: "foreign-edit",
      sourceAuthority: { kind: "complete", collectedCount: 1, authorityTotal: 1 },
    })!;
    const gap = mapPersistentGapToHealthObservation({
      ...base,
      gapFingerprint: "gap",
    });
    expect(retry.sourceWorkId).toBe(first.sourceWorkId);
    expect(retry.sourceAttempt).toBe(3);
    expect(gap.sourceWorkId).not.toBe(first.sourceWorkId);
    expect(gap.outcome).toBe("failure");
  });
});
