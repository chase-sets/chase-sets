import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tcgplayerLiveExportHeader } from "../../tcgplayer-csv/domain/profile";
import { connectorPolicyDefaults, decodeConnectorPolicy } from "../../connector-feed/domain/policy";
import { assertConnectorClaim, assertConnectorReport } from "../../connector-feed/domain/transport";
import { assertLiveExportPayload, deriveLiveExportId, deriveLiveExportOperationId } from "../api/live-export-payload";
import { payloadDigest } from "../api/payload-digest";
import {
  assertClaimedLiveExportOutcome,
  assertLiveExportPayloadStructure,
  liveExportBounds,
  liveExportHeaderSha256,
  liveExportUnknownReasons,
  liveExportAbandonReasons,
  type LiveExportPayload,
  type ClaimedLiveExportOutcome,
} from "../domain/live-export-codec";

const payload: LiveExportPayload = {
  kind: "live-export",
  version: 1,
  connectionId: "connection_synthetic",
  exportId: deriveLiveExportId("connection_synthetic", 1),
  scheduleGeneration: 1,
  parserProfile: { id: "tcgplayer-live-export/v1", headerSha256: liveExportHeaderSha256 },
  limits: { maxBytes: connectorPolicyDefaults.maxIngestBytes, maxRecords: connectorPolicyDefaults.maxIngestRecords },
  bounds: liveExportBounds,
};
const outcome: ClaimedLiveExportOutcome = {
  operationKind: "tcgplayer-live-export",
  operationId: deriveLiveExportOperationId(payload.connectionId, 1),
  attemptId: "attempt_synthetic",
  claimGeneration: 1,
  exportId: payload.exportId,
  payloadDigest: payloadDigest(payload),
  outcome: {
    kind: "live-export-complete",
    exportId: payload.exportId,
    fileSha256: "a".repeat(64),
    capturedAt: "2026-10-10T12:00:00Z",
    parsedRowCount: 0,
    externalReference: "synthetic-export",
  },
};

describe("live-export-codec", () => {
  it("round-trips through browser-safe and server validators and pins the landed header and identity", () => {
    expect(liveExportHeaderSha256).toBe(
      createHash("sha256").update(tcgplayerLiveExportHeader.join("\n")).digest("hex"),
    );
    const digest = createHash("sha256").update(`live-export\0${payload.connectionId}\0${1}`).digest("hex").slice(0, 40);
    expect(payload.exportId).toBe(`cxpl_${digest}`);
    expect(outcome.operationId).toBe(`cxp_${digest}`);
    for (const validate of [assertLiveExportPayloadStructure, assertLiveExportPayload]) {
      expect(() => validate(JSON.parse(JSON.stringify(payload)), connectorPolicyDefaults.leaseMs)).not.toThrow();
    }
    expect(() => assertClaimedLiveExportOutcome(JSON.parse(JSON.stringify(outcome)))).not.toThrow();
    expect(() => assertConnectorReport({ reservationId: "reservation_synthetic", outcomes: [outcome] })).not.toThrow();
    expect(() => assertConnectorClaim({ capabilities: ["tcgplayer-live-export"] })).not.toThrow();
  });

  it("field-deletion and extra-field mutants refuse at every payload nesting level", () => {
    for (const path of [null, "parserProfile", "limits", "bounds"] as const) {
      const source = path ? payload[path] : payload;
      for (const key of [...Object.keys(source), "extra"]) {
        const changed = structuredClone(payload);
        const record = (path ? changed[path] : changed) as Record<string, unknown>;
        if (key === "extra") record.extra = true;
        else delete record[key];
        for (const validate of [assertLiveExportPayloadStructure, assertLiveExportPayload])
          expect(() => validate(changed), `${path}.${key}`).toThrow();
      }
    }
  });

  it("refuses wrong profile digest, identity, every bound overflow and the exact lease margin", () => {
    expect(() =>
      assertLiveExportPayloadStructure({
        ...payload,
        parserProfile: { ...payload.parserProfile, headerSha256: "f".repeat(64) },
      }),
    ).toThrow(/parserProfile/);
    expect(() =>
      assertLiveExportPayload({ ...payload, exportId: deriveLiveExportId(payload.connectionId, 2) }),
    ).toThrow(/exportId/);
    for (const key of Object.keys(liveExportBounds) as (keyof typeof liveExportBounds)[]) {
      expect(() =>
        assertLiveExportPayloadStructure({ ...payload, bounds: { ...payload.bounds, [key]: 600_001 } }),
      ).toThrow();
    }
    for (const leaseMs of [140_000, 139_999, Number.NaN])
      expect(() => assertLiveExportPayloadStructure(payload, leaseMs)).toThrow(/leaseMs/);
    expect(() => assertLiveExportPayloadStructure(payload, 140_001)).not.toThrow();
    for (const limits of [
      { maxBytes: 134_217_729, maxRecords: 1 },
      { maxBytes: 1_048_576, maxRecords: 1_000_001 },
    ])
      expect(() => assertLiveExportPayloadStructure({ ...payload, limits })).toThrow();
  });

  it("all closed outcomes round-trip; field deletion, extra fields, binding and unknown reasons refuse", () => {
    const bodies: ClaimedLiveExportOutcome["outcome"][] = [
      outcome.outcome,
      ...liveExportUnknownReasons.map((reason) => ({
        kind: "live-export-unknown" as const,
        exportId: payload.exportId,
        reason,
      })),
      ...liveExportAbandonReasons.map((reason) => ({ kind: "abandoned" as const, reason })),
    ];
    for (const body of bodies) {
      const report = { ...outcome, outcome: body };
      expect(() => assertClaimedLiveExportOutcome(JSON.parse(JSON.stringify(report)))).not.toThrow();
      for (const key of [...Object.keys(body), "extra"]) {
        const changed: Record<string, unknown> = { ...body };
        if (key === "extra") changed.extra = true;
        else delete changed[key];
        expect(() => assertClaimedLiveExportOutcome({ ...report, outcome: changed })).toThrow();
      }
    }
    for (const key of [...Object.keys(outcome), "extra"]) {
      const changed: Record<string, unknown> = { ...outcome };
      if (key === "extra") changed.extra = true;
      else delete changed[key];
      expect(() => assertClaimedLiveExportOutcome(changed)).toThrow();
    }
    expect(() =>
      assertClaimedLiveExportOutcome({ ...outcome, exportId: deriveLiveExportId(payload.connectionId, 2) }),
    ).toThrow(/binding/);
    expect(() =>
      assertClaimedLiveExportOutcome({ ...outcome, outcome: { kind: "abandoned", reason: "retry" } }),
    ).toThrow();
    expect(() =>
      assertClaimedLiveExportOutcome({
        ...outcome,
        outcome: { kind: "live-export-unknown", exportId: payload.exportId, reason: "retry" },
      }),
    ).toThrow();
  });

  it("policy cadence defaults older documents and refuses missing required or out-of-range fields", () => {
    const { liveExportIntervalSeconds: _, ...legacy } = connectorPolicyDefaults;
    expect(decodeConnectorPolicy(legacy)).toEqual(connectorPolicyDefaults);
    for (const value of [60, 21_600, 86_400])
      expect(decodeConnectorPolicy({ ...legacy, liveExportIntervalSeconds: value }).liveExportIntervalSeconds).toBe(
        value,
      );
    for (const value of [null, 59, 86_401, 1.5])
      expect(() => decodeConnectorPolicy({ ...legacy, liveExportIntervalSeconds: value })).toThrow();
    const { leaseMs: __, ...incomplete } = legacy;
    expect(() => decodeConnectorPolicy(incomplete)).toThrow();
    expect(() => decodeConnectorPolicy({ ...legacy, extra: true })).toThrow();
  });
});
