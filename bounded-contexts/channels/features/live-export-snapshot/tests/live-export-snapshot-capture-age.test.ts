import { describe, expect, it } from "vitest";
import { evaluateSnapshotAge, type SnapshotAgeMetadata } from "../../reconciliation/domain/snapshot-age";
import { ageReaderMutant } from "./mutants";

const run = "2026-10-11T12:00:00.000Z";
const latest: SnapshotAgeMetadata = {
  snapshotId: "synthetic-connector-snapshot",
  snapshotGeneration: 2,
  capturedAt: "2026-10-10T12:00:00.000Z",
  ingestedAt: run,
  capturedAtSource: "connector-captured",
};
const age = (rows: readonly SnapshotAgeMetadata[], at = run) => evaluateSnapshotAge(rows, at, 86_400_000);

describe("live-export-snapshot-capture-age", () => {
  it.each([-1, 0, 1])("keeps the exact 86400000 ms boundary (%i)", (delta) => {
    expect(age([latest], new Date(Date.parse(run) + delta).toISOString()).kind).toBe(delta > 0 ? "stale" : "fresh");
  });
  it.each(["operator-declared", "connector-captured", "ingest"] as const)("previous %s attribution", (source) => {
    const previous = { ...latest, snapshotGeneration: 1, capturedAt: "2026-10-09T12:00:00Z", capturedAtSource: source };
    expect(age([latest, previous])).toEqual(
      source === "ingest" ? { kind: "unknown", reason: "snapshot-capture-unattributed" } : { kind: "fresh" },
    );
  });
  it.each([
    { capturedAt: "2026-10-12T12:00:00Z", ingestedAt: "2026-10-13T12:00:00Z" },
    { capturedAt: "2026-10-11T11:00:00Z", ingestedAt: "2026-10-11T10:00:00Z" },
  ])("rejects future vs run or ingestion: %j", (overrides) => {
    expect(age([{ ...latest, ...overrides }])).toEqual({ kind: "unknown", reason: "snapshot-capture-future" });
  });
  it.each(["2026-10-10T12:00:00Z", "2026-10-10T13:00:00Z"])(
    "rejects non-increasing capture beside %s",
    (capturedAt) => {
      expect(age([latest, { ...latest, snapshotGeneration: 1, capturedAt }])).toEqual({
        kind: "unknown",
        reason: "snapshot-capture-not-increasing",
      });
    },
  );
  it("does not turn ingestion into attributed capture or change invalid/missing reasons", () => {
    expect(age([{ ...latest, capturedAtSource: "ingest" }])).toEqual({
      kind: "unknown",
      reason: "snapshot-capture-unattributed",
    });
    expect(age([{ ...latest, capturedAt: "invalid" }])).toEqual({
      kind: "unknown",
      reason: "snapshot-capture-invalid",
    });
    expect(age([])).toEqual({ kind: "unknown", reason: "snapshot-missing" });
  });
  it("reader-drops-connector-captured mutant fails the governing fresh assertion", () => {
    const mutant = ageReaderMutant('  "connector-captured",', "");
    expect(age([latest])).toEqual({ kind: "fresh" });
    expect(mutant([latest], run, 86_400_000)).toEqual({ kind: "unknown", reason: "snapshot-capture-unattributed" });
  });
});
