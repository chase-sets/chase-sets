import { describe, expect, it } from "vitest";
import { mapChannelDriftToHealthObservation } from "../domain/health";
import type { ChannelDriftClassification, ChannelSourceAuthority } from "../domain/contracts";
import { decodeRetainedDriftGeneration, retainDriftGeneration, type DriftGenerationMember } from "../domain/generation";

const base = {
  connectionId: "connection-1",
  runGeneration: 5,
  sourceAttempt: 2,
  resultOrdinal: 1,
  policyRevision: "3".repeat(64),
  evaluationGeneration: 4,
  materialFingerprint: "a".repeat(64),
  occurredAt: "2026-09-12T06:00:00.000Z",
} as const;

describe("channel-reconciliation-health-outcome-table", () => {
  it("claimed-snapshot-age attention authorizes only a claimed failure, never completeness or unrelated absence", () => {
    expect(
      mapChannelDriftToHealthObservation({
        ...base,
        classification: "source-unavailable",
        sourceAuthority: { kind: "absent-by-design", reason: "claimed-snapshot-not-installed" },
        snapshotAgeAttention: true,
      }),
    ).toMatchObject({ outcome: "failure", reasonCode: "drift" });
    expect(
      mapChannelDriftToHealthObservation({
        ...base,
        classification: "in-sync",
        sourceAuthority: { kind: "absent-by-design", reason: "claimed-snapshot-not-installed" },
        snapshotAgeAttention: true,
      }),
    ).toBeNull();
    expect(
      mapChannelDriftToHealthObservation({
        ...base,
        classification: "source-unavailable",
        sourceAuthority: { kind: "absent-by-design", reason: "reconciliation-capability-unregistered" },
        snapshotAgeAttention: true,
      }),
    ).toBeNull();
  });
  const foreign: DriftGenerationMember = {
    identity: "listing:synthetic-one",
    kind: "foreign-edit",
    expectedFingerprint: "1".repeat(64),
    observedFingerprint: "a".repeat(64),
    settlement: "open",
    decisionRevision: 0,
    recoveryRequested: false,
  };
  it("recovers missing members only with clean authority and preserves the closed generation on replay", () => {
    const opening = retainDriftGeneration(null, [foreign], false)!;
    expect(retainDriftGeneration(opening, [], false)).toEqual(opening);
    const recovered = retainDriftGeneration(opening, [], true);
    expect(recovered).toEqual({
      ...opening,
      members: [{ ...foreign, settlement: "recovered" }],
      resolution: "recovered-automatically",
    });
    expect(retainDriftGeneration(recovered, [], true)).toEqual(recovered);
  });
  it("retains dirty members and does not forget repush provenance when subsequently accepted", () => {
    const opening = retainDriftGeneration(null, [foreign], false)!;
    const accepted = { ...foreign, settlement: "accepted" as const };
    expect(retainDriftGeneration(opening, [accepted], false)?.resolution).toBeNull();
    const repush = retainDriftGeneration(opening, [{ ...foreign, recoveryRequested: true }], false)!;
    expect(retainDriftGeneration(repush, [accepted], true)).toMatchObject({
      fingerprint: opening.fingerprint,
      resolution: "recovered-automatically",
    });
    expect(retainDriftGeneration(opening, [accepted], true)?.resolution).toBe("handled-on-channel");
  });
  it("rejects poisoned membership fingerprints, duplicate members, hidden fields, and false accepted closure", () => {
    const opening = retainDriftGeneration(null, [foreign], false)!;
    expect(decodeRetainedDriftGeneration(opening)).toEqual(opening);
    expect(() => decodeRetainedDriftGeneration({ ...opening, members: [foreign, foreign] })).toThrow();
    expect(() => decodeRetainedDriftGeneration({ ...opening, fingerprint: "c".repeat(64) })).toThrow();
    expect(() => decodeRetainedDriftGeneration({ ...opening, resolution: "handled-on-channel" })).toThrow();
    expect(() =>
      decodeRetainedDriftGeneration({ ...opening, members: [{ ...foreign, rawProviderText: "forbidden" }] }),
    ).toThrow();
  });
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

  it("keeps attempt out of sourceWorkId and preserves the retained generation fingerprint", () => {
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
    expect(retry.sourceWorkId).toBe(first.sourceWorkId);
    expect(retry.sourceAttempt).toBe(3);
    expect(first.fingerprint).toBe(base.materialFingerprint);
    expect(retry.fingerprint).toBe(first.fingerprint);
  });
});
