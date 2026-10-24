import { describe, expect, it, vi } from "vitest";
import { assertConnectorReport } from "../domain/transport";
import { parseExecutorResult } from "../../connector-client/domain/operation-protocol";
import { createOutboundSyncRuntime } from "../../outbound-sync/api/runtime";
import { deriveClaimedOperationOutcomes } from "../../tcgplayer-csv/domain/lifecycle";
import { readbackRun, readbackSettlement } from "../../tcgplayer-csv/tests/readback-test-support";

const outcomes = deriveClaimedOperationOutcomes({ ...readbackRun(), state: "applied" });
const counts = { preRows: 1, postRows: 1, members: 1 };
const reasons = [
  "missing-completeness-discriminator",
  "incomplete-readback",
  "overflow-readback",
  "authority-unavailable",
  "id-set-changed",
  "member-projection-mismatch",
  "non-member-drift",
] as const;
const valid = [
  null,
  { kind: "applied", counts },
  { kind: "basis-diverged", counts },
  ...reasons.map((reason) => ({ kind: "outcome-unknown", reason, counts })),
];
const invalid = [
  { kind: "outcome-unknown", counts, reason: ["non-member-drift"] },
  undefined,
  {},
  [],
  "applied",
  { kind: "proceed", counts },
  { kind: "applied" },
  { kind: "applied", counts, reason: "non-member-drift" },
  { kind: "applied", counts, bytes: "READBACK_SENTINEL" },
  { kind: "outcome-unknown", counts },
  { kind: "outcome-unknown", counts, reason: "other" },
  { kind: "applied", counts: { ...counts, nested: { bytes: "READBACK_SENTINEL" } } },
  { kind: "applied", counts: { preRows: 1, postRows: 1 } },
  ...["preRows", "postRows", "members"].flatMap((key) =>
    [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, key === "members" ? 501 : 513].map((value) => ({
      kind: "applied",
      counts: { ...counts, [key]: value },
    })),
  ),
];

function reportWith(verdict: unknown) {
  const { context: _context, ...settlement } = readbackSettlement();
  return {
    reservationId: "reservation-synthetic",
    outcomes,
    runSettlement: { ...settlement, stagedReadback: verdict },
  };
}

describe("connector-run-settlement-readback-contract", () => {
  it.each(valid)("client/feed accept the closed verdict %j", (verdict) => {
    const report = reportWith(verdict);
    expect(() => assertConnectorReport(report)).not.toThrow();
    expect(() => parseExecutorResult({ outcomes, runSettlement: report.runSettlement })).not.toThrow();
  });
  it.each(invalid)("client/feed refuse malformed verdict %j", (verdict) => {
    const report = reportWith(verdict);
    expect(() => assertConnectorReport(report)).toThrow();
    expect(() => parseExecutorResult({ outcomes, runSettlement: report.runSettlement })).toThrow();
  });
  it("requires the field and closes the enclosing report and summary", () => {
    for (const patch of [
      { extra: "READBACK_SENTINEL" },
      {
        importSummary: {
          fileName: "x",
          dateImportedText: "x",
          numberOfProducts: 1,
          recordedAt: "2026-10-01T00:00:00Z",
          raw: "READBACK_SENTINEL",
        },
      },
    ]) {
      const report = reportWith(null);
      Object.assign(report.runSettlement, patch);
      expect(() => assertConnectorReport(report)).toThrow();
      expect(() => parseExecutorResult({ outcomes, runSettlement: report.runSettlement })).toThrow();
    }
    const report = reportWith(null);
    Reflect.deleteProperty(report.runSettlement, "stagedReadback");
    expect(() => assertConnectorReport(report)).toThrow();
  });
  it("outbound decoder accepts closed values and rejects the entire negative matrix before SQL", async () => {
    const query = vi.fn(async () => {
      throw new Error("decoder-reached-db");
    });
    const connect = vi.fn(async () => {
      throw new Error("decoder-reached-db");
    });
    const runtime = createOutboundSyncRuntime({
      db: { query, connect },
      recordOutcome: async () => "applied",
      readAdditionalOutboundHold: async () => ({ held: false, sources: [] }),
    });
    for (const verdict of valid) {
      const settlement = readbackSettlement();
      Object.assign(settlement, { stagedReadback: verdict });
      await expect(
        runtime.reportClaimedOperationOutcomes({
          reservationId: "reservation-synthetic",
          claimant: readbackRun().claimant,
          outcomes,
          runSettlement: settlement,
        }),
      ).rejects.toThrow("decoder-reached-db");
    }
    query.mockClear();
    connect.mockClear();
    for (const verdict of invalid) {
      const settlement = readbackSettlement();
      Object.assign(settlement, { stagedReadback: verdict });
      await expect(
        runtime.reportClaimedOperationOutcomes({
          reservationId: "reservation-synthetic",
          claimant: readbackRun().claimant,
          outcomes,
          runSettlement: settlement,
        }),
      ).rejects.toMatchObject({ code: "invalid-input" });
    }
    for (const patch of [
      { raw: "READBACK_SENTINEL" },
      {
        importSummary: {
          fileName: "x",
          dateImportedText: "x",
          numberOfProducts: 1,
          recordedAt: "2026-10-01T00:00:00Z",
          raw: "READBACK_SENTINEL",
        },
      },
    ]) {
      const settlement = Object.assign(readbackSettlement(), patch);
      await expect(
        runtime.reportClaimedOperationOutcomes({
          reservationId: "reservation-synthetic",
          claimant: readbackRun().claimant,
          outcomes,
          runSettlement: settlement,
        }),
      ).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
