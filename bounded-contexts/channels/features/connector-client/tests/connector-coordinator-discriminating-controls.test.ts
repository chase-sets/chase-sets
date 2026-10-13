import { readFileSync } from "node:fs";
import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedLiveExportOperation, ClaimedSubjectOperation } from "../../outbound-sync/domain/contracts";
import {
  assertLiveExportPayload,
  deriveLiveExportId,
  deriveLiveExportOperationId,
} from "../../outbound-sync/api/live-export-payload";
import { payloadDigest } from "../../outbound-sync/api/payload-digest";
import { liveExportBounds, liveExportHeaderSha256 } from "../../outbound-sync/domain/live-export-codec";
import { connectorPolicyDefaults } from "../../connector-feed/domain/policy";
import * as validation from "../../outbound-sync/domain/validation";
import * as protocol from "../domain/operation-protocol";
import * as journal from "../integrations/connector-indexeddb";
import * as retention from "../domain/raw-export-record";
import * as handoff from "../domain/order-pull-handoff";
import * as execution from "../domain/order-pull-execution";
import * as stagedImport from "../domain/staged-import-dispatch";
import * as stagedImportPolicy from "../../connector-feed/domain/staged-import-dispatch-policy";
import * as pullCodec from "../../outbound-sync/domain/order-pull-codec";
import { coordinatorFixture } from "./coordinator-test-support";
import { evaluate, mutatedCoordinator } from "./coordinator-mutation-support";

async function unsupportedClaim(shape: "export-only" | "export-first" | "export-last") {
  const f = await coordinatorFixture();
  const connectionId = f.input.connectionId;
  const exportId = deriveLiveExportId(connectionId, 1);
  const payload: ClaimedLiveExportOperation["payload"] = {
    kind: "live-export",
    version: 1,
    connectionId,
    exportId,
    scheduleGeneration: 1,
    parserProfile: { id: "tcgplayer-live-export/v1", headerSha256: liveExportHeaderSha256 },
    limits: { maxBytes: connectorPolicyDefaults.maxIngestBytes, maxRecords: connectorPolicyDefaults.maxIngestRecords },
    bounds: liveExportBounds,
  };
  assertLiveExportPayload(payload, Date.parse(f.claim.leaseExpiresAt) - Date.parse(f.claim.reservedAt));
  const member: ClaimedLiveExportOperation = {
    operationId: deriveLiveExportOperationId(connectionId, 1),
    attemptId: "synthetic-live-export-attempt",
    claimGeneration: 1,
    connectionId,
    providerIdentity: f.claim.providerIdentity,
    subject: { kind: "connection", connectionId },
    operationKind: "tcgplayer-live-export",
    exportId,
    scheduleGeneration: 1,
    payload,
    payloadDigest: payloadDigest(payload),
    enqueuedAt: f.claim.reservedAt,
  };
  const operations: readonly ClaimedSubjectOperation[] =
    shape === "export-only"
      ? [member]
      : shape === "export-first"
        ? [member, ...f.claim.operations]
        : [...f.claim.operations, member];
  const claim = { ...f.claim, operations };
  f.claims[0] = claim;
  return { ...f, claim };
}

afterEach(() => vi.restoreAllMocks());
describe("connector-coordinator discriminating controls", () => {
  it.each(["export-only", "export-first", "export-last"] as const)(
    "rejects the whole valid %s claim without writes, dispatch, report or capability advertisement",
    async (shape) => {
      const f = await unsupportedClaim(shape);
      const writes = vi.spyOn(IDBObjectStore.prototype, "put");
      expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "protocol-violation" });
      expect(await f.journal.read(f.input.connectionId)).toEqual({ members: [], reservations: [] });
      expect(writes).not.toHaveBeenCalled();
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.dispatchOnce).not.toHaveBeenCalled();
      expect(f.reports).toEqual([]);
      expect(await f.request.mock.calls[0][0].clone().json()).toEqual({});
    },
  );
  it.each(["export-only", "export-first", "export-last"] as const)(
    "kills admission refusal removal for %s before the journal boundary",
    async (shape) => {
      const source = readFileSync(new URL("../domain/operation-coordinator.ts", import.meta.url), "utf8");
      const guard = 'if (operation.operationKind === "tcgplayer-live-export") refuse();';
      expect(source.split(guard)).toHaveLength(2);
      for (const bypass of [false, true]) {
        const f = await unsupportedClaim(shape);
        // Isolate admit from the independently tested wire parser and stop at the write port,
        // before IndexedDB's unsupported-row schema can mask removal of the admission guard.
        const change = vi.fn(async () => {
          throw new Error("synthetic-journal-boundary");
        });
        const parsed = vi.fn(async () => structuredClone(f.claim));
        const evaluated = evaluate(bypass ? source.replace(guard, "") : source, {
          "../../outbound-sync/domain/validation": validation,
          "./raw-export-record": retention,
          "./order-pull-handoff": handoff,
          "./order-pull-execution": execution,
          "./staged-import-dispatch": stagedImport,
          "../../connector-feed/domain/staged-import-dispatch-policy": stagedImportPolicy,
          "../../outbound-sync/domain/order-pull-codec": pullCodec,
          "../integrations/connector-indexeddb": {
            ...journal,
            createOperationJournal: () => ({ ...f.journal, change }),
          },
          "./operation-protocol": { ...protocol, parseOperationClaim: parsed },
        });
        if (typeof evaluated.createConnectorOperationCoordinator !== "function") throw new Error("missing coordinator");
        const result = await evaluated.createConnectorOperationCoordinator(f.ports).coordinate(f.input);
        expect(parsed).toHaveBeenCalledTimes(1);
        expect(change).toHaveBeenCalledTimes(bypass ? 1 : 0);
        expect(result.outcome).toBe(bypass ? "unknown" : "protocol-violation");
        expect(await f.journal.read(f.input.connectionId)).toEqual({ members: [], reservations: [] });
        expect(f.prepare).not.toHaveBeenCalled();
        expect(f.dispatchOnce).not.toHaveBeenCalled();
        expect(f.reports).toEqual([]);
      }
    },
  );
  it.each([false, true])("captured-cancellation bypass=%s changes the retained-success witness", async (bypass) => {
    const f = await coordinatorFixture();
    f.claims[0] = {
      ...f.claim,
      operations: [f.claim.operations[0], { ...f.claim.operations[0], operationId: "operation-2" }],
    };
    f.dispatchOnce.mockImplementation(async (work) => {
      f.setAuthority("report-only");
      return f.result(work);
    });
    await f.coordinator().coordinate(f.input);
    expect((await f.journal.read(f.input.connectionId)).members.map((member) => member.state)).toEqual([
      "receipt-captured",
      "prepared",
    ]);
    await (bypass ? mutatedCoordinator("captured-cancellation-bypass")(f.ports) : f.coordinator()).coordinate(f.input);
    expect(JSON.parse(f.reports[0]).outcomes.map((item: { outcome: { kind: string } }) => item.outcome.kind)).toEqual(
      bypass ? ["abandoned", "abandoned"] : ["applied", "abandoned"],
    );
    expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
    expect((await f.journal.read(f.input.connectionId)).reservations[0].phase).toBe("acked");
  });
  it.each([false, true])("prepare-dispatch bypass=%s changes the zero-dispatch witness", async (bypass) => {
    const f = await coordinatorFixture();
    f.prepare.mockImplementation(async (work) => ({
      ready: false,
      result: {
        outcomes: f
          .result(work)
          .outcomes.map((item) => ({ ...item, outcome: { kind: "rejected", code: "validation" } })),
      },
    }));
    await (bypass ? mutatedCoordinator("prepare-dispatch")(f.ports) : f.coordinator()).coordinate(f.input);
    expect(f.dispatchOnce.mock.calls.length === 0).toBe(!bypass);
  });
  it.each([false, true])("report-invalid bypass=%s changes the zero-report witness", async (bypass) => {
    const f = await coordinatorFixture();
    f.claims[0] = { ...f.claim, operations: [{ ...f.claim.operations[0], payloadDigest: "0".repeat(64) }] };
    await (bypass ? mutatedCoordinator("report-invalid")(f.ports) : f.coordinator()).coordinate(f.input);
    expect(f.reports.length === 0).toBe(!bypass);
  });
  it.each([false, true])("replay-guard bypass=%s changes the one-mutation witness", async (bypass) => {
    const f = await coordinatorFixture();
    f.dispatchOnce.mockRejectedValueOnce(new Error("synthetic-after-provider-commit"));
    await f.coordinator().coordinate(f.input);
    await (bypass ? mutatedCoordinator("replay-guard")(f.ports) : f.coordinator()).coordinate(f.input);
    expect(f.dispatchOnce.mock.calls.length === 1).toBe(!bypass);
  });
  it.each([false, true])("completeness-bypass=%s changes the zero-claim witness", async (bypass) => {
    const f = await coordinatorFixture();
    const original = IDBObjectStore.prototype.count;
    vi.spyOn(IDBObjectStore.prototype, "count").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = original.apply(this, args);
      request.addEventListener("success", () => Object.defineProperty(request, "result", { value: 1 }));
      return request;
    });
    await (bypass ? mutatedCoordinator("completeness-bypass")(f.ports) : f.coordinator()).coordinate(f.input);
    expect(f.request.mock.calls.length === 0).toBe(!bypass);
  });
  it.each([false, true])("fence-removed bypass=%s changes stale-capture refusal", async (bypass) => {
    const f = await coordinatorFixture();
    f.dispatchOnce.mockImplementation(async (work) => {
      const retained = await f.journal.read(f.input.connectionId);
      await f.journal.change(f.input.connectionId, retained, {
        ...retained,
        reservations: retained.reservations.map((row) => ({
          ...row,
          revision: row.revision + 1,
          lastRefusal: "transport",
        })),
      });
      return f.result(work);
    });
    await (bypass ? mutatedCoordinator("fence-removed")(f.ports) : f.coordinator()).coordinate(f.input);
    expect(f.reports.length === 0).toBe(!bypass);
  });
  it.each([false, true])(
    "per-member-batch-transaction bypass=%s changes the whole-unit dispatch witness",
    async (bypass) => {
      const f = await coordinatorFixture("reservation");
      f.claims[0] = {
        ...f.claim,
        operations: [f.claim.operations[0], { ...f.claim.operations[0], operationId: "operation-2" }],
      };
      await (bypass ? mutatedCoordinator("per-member-batch-transaction")(f.ports) : f.coordinator()).coordinate(
        f.input,
      );
      expect(f.dispatchOnce.mock.calls.length === 1 && f.dispatchOnce.mock.calls[0][0].members.length === 2).toBe(
        !bypass,
      );
    },
  );
});
