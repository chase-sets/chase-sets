import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { manualSyncIngestContract } from "../../manual-sync/domain/contracts";
import { parseTcgplayerFullExport } from "../../tcgplayer-csv/domain/csv";
import { tcgplayerLiveExportHeader } from "../../tcgplayer-csv/domain/profile";
import { assertDerivedTcgplayerSnapshot } from "../../tcgplayer-csv/domain/derived-snapshot";
import { OutboundSyncError, type ClaimedOperationReservation } from "../../outbound-sync/domain/contracts";
import { assertChannelPublicationDraft } from "../../publication-port/domain/validation";
import {
  connectorMaxOperations,
  connectorPolicyDefaults,
  connectorPolicyKeys,
  connectorTransportPolicy,
  decodeConnectorPolicy,
} from "../domain/policy";
import { assertConnectorInbound, assertConnectorReport } from "../domain/transport";
import { createConnectorTransportRoutes } from "../api/transport-routes";
import type { ConnectorTransportServices } from "../api/transport";
import { ConnectorPairingError } from "../domain/contracts";

function snapshot() {
  const values: Record<string, string> = {
    "TCGplayer Id": "123",
    "Total Quantity": "2",
    "Add to Quantity": "0",
    "TCG Marketplace Price": "1.00",
    Condition: "Near Mint",
  };
  const csv =
    tcgplayerLiveExportHeader.join(",") + "\n" + tcgplayerLiveExportHeader.map((key) => values[key] ?? "").join(",");
  const parsed = parseTcgplayerFullExport({ surface: "live", csv }, { maxRecords: 100 });
  if (parsed.kind !== "parsed") throw new Error("invalid-test-snapshot");
  return { parsed, fileSha256: "a".repeat(64), capturedAt: "2026-10-07T12:00:00Z" };
}
function http() {
  const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({ rows: [] });
  const services = {
    resolveTransportPolicy: vi
      .fn<ConnectorTransportServices["resolveTransportPolicy"]>()
      .mockResolvedValue(connectorPolicyDefaults),
    claim: vi.fn<ConnectorTransportServices["claim"]>().mockResolvedValue({ reservation: null, pollWindowSeconds: 60 }),
    report: vi.fn<ConnectorTransportServices["report"]>().mockResolvedValue(undefined),
    ingest: vi.fn<ConnectorTransportServices["ingest"]>().mockResolvedValue(undefined),
    readAdmittedConnectorInboundEvents: vi.fn<ConnectorTransportServices["readAdmittedConnectorInboundEvents"]>(),
  };
  const app = createConnectorTransportRoutes(services, { query });
  return {
    services,
    query,
    request: (operation: string, value: unknown = {}, token = "sentinel-token") =>
      app.request(`/connections/connection_test/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(value),
      }),
  };
}

describe("connector-policy-manual-ingest-parity", () => {
  it("shares ingest defaults and independently names policy keys", () => {
    expect(connectorTransportPolicy.defaultValue).toEqual(connectorPolicyDefaults);
    expect(connectorPolicyDefaults.maxIngestBytes).toBe(manualSyncIngestContract.maxBytes);
    expect(connectorPolicyDefaults.maxIngestRecords).toBe(manualSyncIngestContract.maxRecords);
    expect(Object.keys(connectorPolicyDefaults)).toEqual([...connectorPolicyKeys]);
    expect(
      decodeConnectorPolicy({
        ...connectorPolicyDefaults,
        maxIngestRecords: 1,
        maxOperationsPerClaim: connectorMaxOperations,
      }),
    ).toMatchObject({ maxIngestRecords: 1, maxOperationsPerClaim: 1_000_000 });
  });
  it("pins the ceiling to the actual producer assertion rather than a transport-only fixture", () => {
    const source = readFileSync(new URL("../../outbound-sync/api/store.ts", import.meta.url), "utf8");
    const assertion = source.slice(
      source.indexOf("function assertReserveClaimedOutboundOperationsInput("),
      source.indexOf("async function reserveClaimedOutboundOperations("),
    );
    const match = /input\.maxOperations > ([\d_]+)/.exec(assertion);
    expect(match).not.toBeNull();
    expect(Number(match?.[1]?.replaceAll("_", ""))).toBe(connectorMaxOperations);
  });
  it.each([
    null,
    {},
    { ...connectorPolicyDefaults, unknown: true },
    { ...connectorPolicyDefaults, leaseMs: 59_999 },
    { ...connectorPolicyDefaults, leaseMs: 7_200_001 },
    { ...connectorPolicyDefaults, pollWindowSeconds: 0 },
    { ...connectorPolicyDefaults, maxOperationsPerClaim: 1_000_001 },
    { ...connectorPolicyDefaults, maxIngestBytes: 134_217_729 },
    { ...connectorPolicyDefaults, maxIngestRecords: 1.5 },
    { ...connectorPolicyDefaults, maxIngestRecords: "100" },
  ])("refuses malformed active values: %j", (value) => {
    expect(() => decodeConnectorPolicy(value)).toThrow();
  });
});

describe("connector-feed-malformed-payload", () => {
  it("accepts the real pure parser result without changing it", () => {
    const payload = snapshot();
    const before = JSON.stringify(payload);
    assertDerivedTcgplayerSnapshot(payload, { maxBytes: manualSyncIngestContract.maxBytes, maxRecords: 1 });
    expect(JSON.stringify(payload)).toBe(before);
    assertConnectorInbound(
      { inboundKind: "export", externalReference: "export.v1:abc", payload },
      connectorPolicyDefaults,
    );
  });
  it("refuses raw CSV, refused/staged results and recursive extra fields", () => {
    const payload = snapshot();
    for (const invalid of [
      "csv,text",
      { ...payload, raw: "csv" },
      { ...payload, parsed: { kind: "refused", reason: "empty-export" } },
      { ...payload, parsed: { ...payload.parsed, surface: "staged" } },
      { ...payload, capturedAt: "2026-10-07" },
      { ...payload, fileSha256: "A".repeat(64) },
      { ...payload, parsed: { ...payload.parsed, extra: true } },
      { ...payload, parsed: { ...payload.parsed, parsedRowCount: 2 } },
      { ...payload, parsed: { ...payload.parsed, rows: payload.parsed.rows.map((row) => ({ ...row, extra: true })) } },
      {
        ...payload,
        parsed: {
          ...payload.parsed,
          rows: payload.parsed.rows.map((row) => ({ ...row, referenceColumns: { unlisted: "x" } })),
        },
      },
      {
        ...payload,
        parsed: { ...payload.parsed, rows: payload.parsed.rows.map((row) => ({ ...row, totalQuantity: 1_000_001 })) },
      },
      {
        ...payload,
        parsed: {
          ...payload.parsed,
          rows: payload.parsed.rows.map((row) => ({ ...row, rowNumber: Number.MAX_SAFE_INTEGER + 1 })),
        },
      },
    ]) {
      expect(() =>
        assertDerivedTcgplayerSnapshot(invalid, { maxBytes: manualSyncIngestContract.maxBytes, maxRecords: 1 }),
      ).toThrow();
      expect(() =>
        assertConnectorInbound(
          { inboundKind: "export", externalReference: "export.v1:invalid", payload: invalid },
          connectorPolicyDefaults,
        ),
      ).toThrow();
    }
  });
  it("enforces logical rows, increasing unique row numbers, reference grammar and exact byte ceiling", () => {
    const payload = snapshot();
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    expect(() => assertDerivedTcgplayerSnapshot(payload, { maxBytes: bytes, maxRecords: 1 })).not.toThrow();
    expect(() => assertDerivedTcgplayerSnapshot(payload, { maxBytes: bytes - 1, maxRecords: 1 })).toThrow();
    const two = {
      ...payload,
      parsed: { ...payload.parsed, parsedRowCount: 2, rows: [...payload.parsed.rows, ...payload.parsed.rows] },
    };
    expect(() => assertDerivedTcgplayerSnapshot(two, { maxBytes: bytes * 3, maxRecords: 1 })).toThrow();
    expect(() => assertDerivedTcgplayerSnapshot(two, { maxBytes: bytes * 3, maxRecords: 2 })).toThrow();
    for (const externalReference of ["", "x".repeat(513), "a/b", '{"order":1}', "é"]) {
      expect(() =>
        assertConnectorInbound(
          { inboundKind: "order", externalReference, payload: { version: 1, records: [{}] } },
          connectorPolicyDefaults,
        ),
      ).toThrow();
    }
  });
  it("derives nested acknowledgement grammar from the producer and closes run settlement", () => {
    const valid = {
      reservationId: "cor_1",
      outcomes: [
        {
          operationId: "cop_1",
          attemptId: "coa_1",
          claimGeneration: 1,
          desiredStateSequence: 1,
          outcome: { kind: "outcome-unknown" },
        },
      ],
    };
    expect(() => assertConnectorReport(valid)).not.toThrow();
    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, outcomes: [{ ...valid.outcomes[0], desiredStateSequence: 0 }] },
      { ...valid, outcomes: [{ ...valid.outcomes[0], outcome: { kind: "outcome-unknown", extra: true } }] },
      { ...valid, runSettlement: { context: { extra: true } } },
    ])
      expect(() => assertConnectorReport(invalid)).toThrow();
  });
  it("validates every nested settlement branch without changing the posted producer contract", () => {
    const runSettlement = {
      runId: "run_test",
      expectedRunRevision: 1,
      fromState: "claimed",
      toState: "applied",
      verificationSnapshotId: "snapshot_test",
      verificationSnapshotGeneration: 1,
      uploadAttemptedAt: "2026-10-07T12:00:00Z",
      uploadFileName: "synthetic.csv",
      importSummary: {
        fileName: "synthetic.csv",
        dateImportedText: "October 7",
        numberOfProducts: 1,
        recordedAt: "2026-10-07T12:00:00Z",
      },
      context: {
        tenantId: "tnt_test",
        audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
        trace: { traceId: "trace_test", spanId: "span_test" },
      },
    };
    const report = { reservationId: "cor_test", outcomes: [], runSettlement };
    const bytes = JSON.stringify(report);
    expect(() => assertConnectorReport(report)).not.toThrow();
    expect(JSON.stringify(report)).toBe(bytes);
    for (const invalid of [
      { ...runSettlement, fromState: "applied" },
      { ...runSettlement, uploadAttemptedAt: "2026-10-07" },
      { ...runSettlement, expectedRunRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...runSettlement, uploadFileName: "x".repeat(513) },
      { ...runSettlement, importSummary: { ...runSettlement.importSummary, numberOfProducts: "1" } },
      { ...runSettlement, importSummary: { ...runSettlement.importSummary, extra: true } },
      { ...runSettlement, context: { ...runSettlement.context, extra: true } },
      {
        ...runSettlement,
        context: { ...runSettlement.context, audit: { ...runSettlement.context.audit, extra: true } },
      },
      { ...runSettlement, context: { ...runSettlement.context, trace: { traceId: 1 } } },
      { ...runSettlement, context: { ...runSettlement.context, trace: { extra: true } } },
    ])
      expect(() => assertConnectorReport({ ...report, runSettlement: invalid })).toThrow();
  });
  it("bounds opaque order content without interpreting consumer fields", () => {
    const payload = { version: 1, records: [{ order: { revision: 2, customer: ["synthetic", null, true] } }] };
    const envelope = { inboundKind: "order", externalReference: "order.v1:revision-2", payload };
    const before = JSON.stringify(envelope);
    expect(() => assertConnectorInbound(envelope, connectorPolicyDefaults)).not.toThrow();
    expect(JSON.stringify(envelope)).toBe(before);
    for (const record of [
      { field: "unsafe\u0000scalar" },
      { field: "\ud800" },
      { field: Number.MAX_SAFE_INTEGER + 1 },
      { constructor: "unsafe" },
      { field: Infinity },
      { field: "x".repeat(513) },
    ])
      expect(() =>
        assertConnectorInbound(
          { ...envelope, payload: { version: 1, records: [record] } },
          { ...connectorPolicyDefaults, maxIngestBytes: 512 },
        ),
      ).toThrow();
    expect(() =>
      assertConnectorInbound(
        { ...envelope, payload: { version: 1, records: [{}, {}] } },
        { ...connectorPolicyDefaults, maxIngestRecords: 1 },
      ),
    ).toThrow();
  });
});

describe("connector-feed-audit-completeness", () => {
  it("streams a producer-maximum member without a smaller response cap or identity substitution", async () => {
    const h = http();
    const draft = {
      channelListingId: "l".repeat(128),
      listingRevision: Number.MAX_SAFE_INTEGER,
      title: "x".repeat(4096),
      description: "x".repeat(100_000),
      categoryKey: "x".repeat(256),
      conditionKey: "x".repeat(256),
      price: { amountMinor: Number.MAX_SAFE_INTEGER, currency: "USD" },
      quantity: 1_000_000,
      attributes: Array.from({ length: 200 }, (_, index) => ({
        key: String(index).padEnd(256, "x"),
        value: "x".repeat(4096),
      })),
    };
    assertChannelPublicationDraft(draft);
    const providerIdentity = { providerKey: "tcgplayer", environment: "sandbox" as const };
    const reservation: ClaimedOperationReservation = {
      reservationId: "cor_max",
      connectionId: "connection_test",
      providerIdentity,
      claimant: { claimantKind: "connector", claimantId: "pair_test" },
      reservedAt: "2026-10-07T12:00:00Z",
      leaseExpiresAt: "2026-10-07T12:30:00Z",
      operations: [
        {
          operationId: "cop_max",
          attemptId: "coa_max",
          claimGeneration: Number.MAX_SAFE_INTEGER,
          connectionId: "connection_test",
          providerIdentity,
          channelListingId: draft.channelListingId,
          listingId: "listing_max",
          operationKind: "publish",
          listingRevision: draft.listingRevision,
          desiredStateSequence: Number.MAX_SAFE_INTEGER,
          payload: { kind: "draft", draft },
          payloadDigest: "a".repeat(64),
          sourceOccurredAt: "2026-10-07T12:00:00Z",
          enqueuedAt: "2026-10-07T12:00:00Z",
        },
      ],
    };
    h.services.claim.mockResolvedValue({ reservation, pollWindowSeconds: 3600 });
    const response = await h.request("claim");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reservation, pollWindowSeconds: 3600 });
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it.each([connectorPolicyDefaults.maxOperationsPerClaim, 1])(
    "refuses a report above the resolved policy byte bound (%i operations) before calling the service",
    async (maxOperationsPerClaim) => {
      const h = http();
      h.services.resolveTransportPolicy.mockResolvedValue({ ...connectorPolicyDefaults, maxOperationsPerClaim });
      const bound = maxOperationsPerClaim * 16_384 + 65_536 + 1_048_576;
      const response = await h.request("report", "x".repeat(bound - 1));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "report-refused", reason: "invalid-input" });
      expect(h.services.report).not.toHaveBeenCalled();
      expect(h.query).toHaveBeenCalledTimes(1);
    },
  );
  it.each([connectorPolicyDefaults.maxOperationsPerClaim, 1])(
    "passes a report at the resolved policy byte bound (%i operations) to the service",
    async (maxOperationsPerClaim) => {
      const h = http();
      h.services.resolveTransportPolicy.mockResolvedValue({ ...connectorPolicyDefaults, maxOperationsPerClaim });
      const bound = maxOperationsPerClaim * 16_384 + 65_536 + 1_048_576;
      const value = "x".repeat(bound - 2);
      const response = await h.request("report", value);
      expect(response.status).toBe(200);
      expect(h.services.report).toHaveBeenCalledExactlyOnceWith(
        { token: "sentinel-token", connectionId: "connection_test" },
        value,
        expect.any(Function),
      );
      expect(h.query).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["ingest", "report"])(
    "returns byte-identical %s success without a replay discriminator and audits once per call",
    async (operation) => {
      const h = http();
      const first = await h.request(operation);
      const repeat = await h.request(operation);
      expect(first.status).toBe(operation === "ingest" ? 202 : 200);
      expect(repeat.status).toBe(first.status);
      expect(await first.text()).toBe("{}");
      expect(await repeat.text()).toBe("{}");
      expect([...first.headers]).toEqual([...repeat.headers]);
      expect(h.query).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(h.query.mock.calls)).not.toContain("sentinel-token");
    },
  );
  it.each([
    "reservation-expired",
    "reservation-membership-mismatch",
    "stale-fence",
    "run-settlement-unavailable",
    "invalid-input",
  ] as const)("preserves the closed producer refusal %s", async (reason) => {
    const h = http();
    h.services.report.mockRejectedValue(new OutboundSyncError(reason, "raw-secret-sentinel"));
    const response = await h.request("report");
    expect(response.status).toBe(reason === "invalid-input" ? 400 : 409);
    expect(await response.json()).toEqual({ code: "report-refused", reason });
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.query.mock.calls)).not.toContain("raw-secret-sentinel");
  });
  it("uses the same refusal for foreign and nonexistent targets, with no unverified route identity", async () => {
    const h = http();
    h.services.ingest
      .mockRejectedValueOnce(new ConnectorPairingError("invalid-credential"))
      .mockRejectedValueOnce(new ConnectorPairingError("connection-not-found"));
    const first = await h.request("ingest");
    const second = await h.request("ingest");
    expect(first.status).toBe(second.status);
    expect(await first.text()).toBe(await second.text());
    for (const [, params] of h.query.mock.calls) expect(params?.slice(1, 3)).toEqual([null, null]);
  });
  it("does not acknowledge or leak a failed required audit", async () => {
    const h = http();
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.query.mockRejectedValue(new Error("audit-secret-sentinel"));
      const response = await h.request("ingest");
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"code":"unavailable"}');
      expect(h.query).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logs.mock.calls)).not.toContain("audit-secret-sentinel");
    } finally {
      logs.mockRestore();
    }
  });
  it("bounds unknown failures without logging their exception message", async () => {
    const h = http();
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.services.claim.mockRejectedValue(new Error("raw-secret-sentinel"));
      const response = await h.request("claim");
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"code":"unavailable"}');
      expect(JSON.stringify([h.query.mock.calls, logs.mock.calls])).not.toContain("raw-secret-sentinel");
      expect(h.query).toHaveBeenCalledTimes(1);
    } finally {
      logs.mockRestore();
    }
  });
});
