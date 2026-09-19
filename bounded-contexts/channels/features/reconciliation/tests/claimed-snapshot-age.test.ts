import { describe, expect, it } from "vitest";
import { evaluateSnapshotAge, SNAPSHOT_AGE_MEMBER_ID, type SnapshotAgeMetadata } from "../domain/snapshot-age";
import { decodeRetainedDriftGeneration, retainDriftGeneration, type DriftGenerationMember } from "../domain/generation";

const runAt = "2026-09-16T12:00:00.000Z";
const capture = "2026-09-15T12:00:00.000Z";
const snapshot = (overrides: Partial<SnapshotAgeMetadata> = {}): SnapshotAgeMetadata => ({
  snapshotId: "synthetic-live-2",
  snapshotGeneration: 2,
  capturedAt: capture,
  ingestedAt: runAt,
  capturedAtSource: "operator-declared",
  ...overrides,
});

describe("claimed-snapshot-age-matrix", () => {
  it.each([-1, 0, 1])("uses the strict age boundary at %i ms", (delta) => {
    expect(evaluateSnapshotAge([snapshot()], new Date(Date.parse(runAt) + delta).toISOString(), 86_400_000).kind).toBe(
      delta > 0 ? "stale" : "fresh",
    );
  });
  it("accepts first capture and only an increasing eligible immediate pair", () => {
    expect(evaluateSnapshotAge([snapshot()], runAt, 86_400_000).kind).toBe("fresh");
    expect(
      evaluateSnapshotAge(
        [snapshot(), snapshot({ snapshotGeneration: 1, capturedAt: "2026-09-14T12:00:00Z" })],
        runAt,
        86_400_000,
      ).kind,
    ).toBe("fresh");
    for (const capturedAt of [capture, "2026-09-16T11:00:00Z"])
      expect(evaluateSnapshotAge([snapshot(), snapshot({ capturedAt })], runAt, 86_400_000)).toEqual({
        kind: "unknown",
        reason: "snapshot-capture-not-increasing",
      });
  });
  it("rejects missing snapshots", () => {
    expect(evaluateSnapshotAge([], runAt, 86_400_000)).toEqual({ kind: "unknown", reason: "snapshot-missing" });
  });
  it.each([
    { capturedAtSource: "ingest" as const },
    { capturedAt: "invalid" },
    { capturedAt: "2026-09-15T12:00:00" },
    { capturedAt: "infinity" },
    { capturedAt: "2026-02-30T12:00:00Z" },
    { ingestedAt: "invalid" },
    { capturedAt: "2026-09-16T11:00:00Z", ingestedAt: "2026-09-16T10:00:00Z" },
    { capturedAt: "2026-09-16T13:00:00Z", ingestedAt: "2026-09-16T14:00:00Z" },
  ])("rejects invalid evidence in either pair member: %j", (invalid) => {
    expect(evaluateSnapshotAge([snapshot(invalid)], runAt, 86_400_000).kind).toBe("unknown");
    expect(evaluateSnapshotAge([snapshot(), snapshot(invalid)], runAt, 86_400_000).kind).toBe("unknown");
  });
});

it("claimed-snapshot-age-retained removes recovered carried-forward age only and preserves structural/foreign members", () => {
  const member = (identity: string, kind: DriftGenerationMember["kind"]): DriftGenerationMember => ({
    identity,
    kind,
    expectedFingerprint: null,
    observedFingerprint: "a".repeat(64),
    settlement: "open",
    decisionRevision: 0,
    recoveryRequested: false,
  });
  const age = member(SNAPSHOT_AGE_MEMBER_ID, "structural");
  const others = [member("finding:unmapped", "structural"), member("listing:foreign", "foreign-edit")];
  const open = retainDriftGeneration(null, [age, ...others], false)!;
  expect(retainDriftGeneration(open, [age, ...others], false)).toEqual(open);
  const recovered = retainDriftGeneration(open, [{ ...age, settlement: "recovered" }], false)!;
  expect(recovered.members).toEqual(others.sort((a, b) => a.identity.localeCompare(b.identity)));
  expect(recovered.resolution).toBeNull();
  expect(decodeRetainedDriftGeneration(recovered)).toEqual(recovered);
  expect(retainDriftGeneration(recovered, [], false)).toEqual(recovered);
  const carried = {
    ...open,
    members: open.members.map((m) => (m.identity === age.identity ? { ...m, settlement: "recovered" as const } : m)),
  };
  expect(retainDriftGeneration(carried, [], false)).toEqual(recovered);
  expect(retainDriftGeneration(recovered, [age, ...others], false)?.generation).toBe(open.generation + 1);
});
