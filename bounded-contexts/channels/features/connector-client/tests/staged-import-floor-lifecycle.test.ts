import { describe, expect, it } from "vitest";
import { createConnectorOperationCoordinator } from "../domain/operation-coordinator";
import { floorFixture } from "./staged-import-floor-test-support";
import { openConnectorDatabase } from "../integrations/connector-indexeddb";

describe("synthetic staged-import floor lifecycle", () => {
  it("waits a full initial interval then starts at 0/60000/120000 from first eligibility", async () => {
    const f = await floorFixture();
    expect(await createConnectorOperationCoordinator(f.ports).coordinate(f.input)).toEqual({
      outcome: "ok",
      pollWindowSeconds: 60,
    });
    expect(f.starts).toEqual([60000, 120000, 180000]);
    expect(f.policyReads).toHaveLength(4);
    expect(new Set(f.policyReads).size).toBe(4);
  });
  it("long requests delay the next start until completion, never overlap or catch up", async () => {
    const f = await floorFixture([70000, 1000, 1000]);
    await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
    expect(f.starts).toEqual([60000, 130000, 190000]);
    expect(f.completions).toEqual([130000, 131000, 191000]);
  });
  it("absent capture-derived plan disables dispatch before all sends", async () => {
    const f = await floorFixture();
    f.ports.executors = [{ ...f.executor, prepare: async () => ({ ready: true }) }];
    await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.starts).toEqual([]);
  });
  it.each(["complete", "duration", "membership", "batch", "lease", "overflow", "polling", "rows"])(
    "refuses synthetic invalid %s before dispatch",
    async (defect) => {
      const f = await floorFixture();
      const prepare = f.executor.prepare;
      f.ports.executors = [
        {
          ...f.executor,
          prepare: async (unit) => {
            const result = await prepare(unit);
            if (!result.ready || !result.stagedImport) throw new Error("missing-synthetic-plan");
            const plan = structuredClone(f.plan!);
            const patch =
              defect === "complete"
                ? { complete: false }
                : defect === "duration"
                  ? { requests: [{ requestId: "synthetic-hop-0" }] }
                  : defect === "membership"
                    ? { membershipDigest: "0".repeat(64) }
                    : defect === "batch"
                      ? { batchDigest: "0".repeat(64) }
                      : defect === "overflow"
                        ? { platformReadMs: Number.MAX_SAFE_INTEGER }
                        : defect === "polling"
                          ? { polling: true }
                          : defect === "rows"
                            ? { composedRows: 501 }
                            : {};
            if (defect === "lease") f.advance(1800000);
            return { ...result, stagedImport: { ...result.stagedImport, plan: { ...plan, ...patch } } };
          },
        },
      ];
      await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.starts).toEqual([]);
    },
  );
  it.each(["nonce", "revision", "connection", "pairing", "version", "freshness", "pause", "clock"])(
    "fresh pre-send %s failure never sends",
    async (defect) => {
      const f = await floorFixture([1000]);
      const request = f.ports.request;
      let reads = 0;
      f.ports.request = async (req) => {
        const response = await request(req);
        if (!req.url.includes("dispatch-policy")) return response;
        reads++;
        if (reads !== 2) return response;
        const value = await response.json();
        if (defect === "nonce") value.requestNonce = "0".repeat(32);
        if (defect === "revision") value.policy.revision = "0".repeat(64);
        if (defect === "connection") value.connectionId = "foreign";
        if (defect === "pairing") value.pairingId = "foreign";
        if (defect === "version") value.schemaVersion = 2;
        if (defect === "freshness") f.advance(60000);
        if (defect === "pause") f.setAuthority("report-only");
        if (defect === "clock") f.setMonotonic(-1);
        return Response.json(value);
      };
      await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
      expect(f.starts).toEqual([]);
    },
  );
  it("a post-send overrun remains outcome-unknown across every lifecycle wake and re-pair/redelivery", async () => {
    const f = await floorFixture([1000, 1000]);
    const request = f.ports.request;
    f.ports.request = async (req) => {
      const response = await request(req);
      if (req.url.includes("synthetic-provider")) f.advance(1);
      return response;
    };
    await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
    expect(f.starts).toHaveLength(1);
    expect((await f.journal.read(f.input.connectionId)).reservations[0].phase).toBe("outcome-unknown");
    for (const reason of ["boot", "update", "work", "unpair"] as const)
      await createConnectorOperationCoordinator(f.ports).coordinate({ ...f.input, reason });
    f.advance(86400000);
    f.claims.push({
      ...f.claim,
      reservationId: "redelivery",
      claimant: { claimantKind: "connector", claimantId: "repaired" },
    });
    await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
    expect(f.starts).toHaveLength(1);
    expect((await f.journal.read(f.input.connectionId)).reservations[0].stagedImport?.state).toBe("intent");
  });
  it("two workers racing different reservations on one connection have one admission winner", async () => {
    const f = await floorFixture([1000]);
    const second = {
      ...f.claim,
      reservationId: "reservation-2",
      operations: f.claim.operations.map((row) => ({ ...row, operationId: "operation-2", attemptId: "attempt-2" })),
    };
    f.claims.push(second);
    await Promise.all([
      createConnectorOperationCoordinator(f.ports).coordinate(f.input),
      createConnectorOperationCoordinator(f.ports).coordinate(f.input),
    ]);
    expect(f.starts.length).toBeLessThanOrEqual(1);
    expect(f.starts.length).toBeGreaterThan(0);
  });
  it("same live epoch carries cadence across reservations; a new epoch cannot borrow timing credit", async () => {
    const f = await floorFixture([1000]);
    const coordinator = createConnectorOperationCoordinator(f.ports);
    await coordinator.coordinate(f.input);
    f.claims.push({
      ...f.claim,
      reservationId: "reservation-2",
      operations: f.claim.operations.map((row) => ({ ...row, operationId: "operation-2", attemptId: "attempt-2" })),
    });
    await coordinator.coordinate(f.input);
    expect(f.starts).toEqual([60000, 120000]);
    f.claims.push({
      ...f.claim,
      reservationId: "reservation-3",
      operations: f.claim.operations.map((row) => ({ ...row, operationId: "operation-3", attemptId: "attempt-3" })),
    });
    await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
    expect(f.starts).toEqual([60000, 120000, 181000]);
  });
  it("acked is inert, unknown timing cannot be erased or deleted through journal CAS", async () => {
    const f = await floorFixture([1000]);
    await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
    for (const reason of ["boot", "update", "work", "unpair"] as const)
      await createConnectorOperationCoordinator(f.ports).coordinate({ ...f.input, reason });
    expect(f.starts).toHaveLength(1);
    const before = await f.journal.read(f.input.connectionId);
    const row = before.reservations[0];
    await expect(
      f.journal.change(f.input.connectionId, before, {
        ...before,
        reservations: [{ ...row, revision: row.revision + 1, stagedImport: undefined }],
      }),
    ).rejects.toThrow();
  });
  it("newer timing schema is preserved with zero writes, while old prepared records receive a full interval", async () => {
    const f = await floorFixture([1000]);
    f.ports.executors = [{ ...f.executor, prepare: async () => ({ ready: true }) }];
    await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
    const old = await f.journal.read(f.input.connectionId);
    expect(old.reservations[0].stagedImport).toBeUndefined();
    f.ports.executors = [f.executor];
    await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
    expect(f.starts).toEqual([60000]);
    const current = await f.journal.read(f.input.connectionId);
    const newer = {
      ...current.reservations[0],
      stagedImport: { ...current.reservations[0].stagedImport, schemaVersion: 2 },
    };
    const db = await openConnectorDatabase(f.indexedDB);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("reservations", "readwrite");
      tx.objectStore("reservations").put(newer);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const result = await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
    expect(result.outcome).toBe("upgrade-required");
    const preserved = await new Promise<unknown>((resolve, reject) => {
      const req = db
        .transaction("reservations")
        .objectStore("reservations")
        .get([f.input.connectionId, newer.reservationId]);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    expect(preserved).toEqual(newer);
    expect(f.starts).toHaveLength(1);
  });
  it("different connections in the same journal database do not share a throttle", async () => {
    const first = await floorFixture([1000]);
    const second = await floorFixture([1000]);
    second.ports.indexedDB = first.indexedDB;
    second.input.connectionId = "connection-2";
    second.claims[0] = {
      ...second.claim,
      connectionId: "connection-2",
      operations: second.claim.operations.map((row) => ({ ...row, connectionId: "connection-2" })),
    };
    await Promise.all([
      createConnectorOperationCoordinator(first.ports).coordinate(first.input),
      createConnectorOperationCoordinator(second.ports).coordinate(second.input),
    ]);
    expect(first.starts).toEqual([60000]);
    expect(second.starts).toEqual([60000]);
  });
});
