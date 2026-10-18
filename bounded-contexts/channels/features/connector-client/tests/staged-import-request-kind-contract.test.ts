import { describe, expect, it } from "vitest";
import { createConnectorOperationCoordinator } from "../domain/operation-coordinator";
import { decodeStagedImportCapturePlan } from "../domain/staged-import-fit";
import { mutatedStagedImport } from "./coordinator-mutation-support";
import { floorFixture } from "./staged-import-floor-test-support";

type Hop = Readonly<Record<string, unknown>>;
const defects: Readonly<Record<string, (hop: Hop) => Hop>> = {
  missing: (hop) => Object.fromEntries(Object.entries(hop).filter(([key]) => key !== "kind")),
  unknown: (hop) => ({ ...hop, kind: "write" }),
  empty: (hop) => ({ ...hop, kind: "" }),
  null: (hop) => ({ ...hop, kind: null }),
  numeric: (hop) => ({ ...hop, kind: 1 }),
  "case-folded": (hop) => ({ ...hop, kind: "READ" }),
  extra: (hop) => ({ ...hop, mutation: false }),
};

function plan(kinds: readonly unknown[]) {
  return {
    schemaVersion: 1,
    source: "capture-derived",
    captureDigest: "c".repeat(64),
    complete: true,
    polling: false,
    connectionId: "connection-1",
    pairingId: "pairing-1",
    reservationId: "reservation-1",
    executorKey: "synthetic-executor",
    membershipDigest: "a".repeat(64),
    batchDigest: "d".repeat(64),
    composedRows: 1,
    requests: kinds.map((kind, index) => ({ requestId: `synthetic-hop-${index}`, kind, maximumDurationMs: 1000 })),
    platformReadMs: 1,
    parsingMs: 1,
    reportMs: 1,
  };
}

/** A fixture whose executor plan carries the given defect on the second (mutation) hop only. */
async function defective(defect: string) {
  const f = await floorFixture();
  const prepare = f.executor.prepare;
  f.ports.executors = [
    {
      ...f.executor,
      prepare: async (unit) => {
        const result = await prepare(unit);
        if (!result.ready || !result.stagedImport) throw new Error("missing-synthetic-plan");
        const value = structuredClone(f.plan!);
        const requests: Hop[] = value.requests.map((hop, index) => (index === 1 ? defects[defect]!(hop) : hop));
        return { ...result, stagedImport: { ...result.stagedImport, plan: { ...value, requests } } };
      },
    },
  ];
  return f;
}

describe("staged-import-request-kind-contract (synthetic, no provider authority)", () => {
  it("decodes only closed read/mutation kinds and preserves them", () => {
    for (const kinds of [["read"], ["read", "mutation"], ["mutation", "read", "mutation"]])
      expect(decodeStagedImportCapturePlan(plan(kinds)).requests.map((hop) => hop.kind)).toEqual(kinds);
    for (const [defect, patch] of Object.entries(defects)) {
      const value = plan(["read", "mutation"]);
      const requests = value.requests.map((hop, index) => (index === 1 ? patch(hop) : hop));
      expect(() => decodeStagedImportCapturePlan({ ...value, requests }), defect).toThrow(
        "staged-import-plan-unavailable",
      );
    }
  });
  it.each(Object.keys(defects))(
    "a %s request kind refuses before any request through the real coordinator",
    async (defect) => {
      const f = await defective(defect);
      expect(await createConnectorOperationCoordinator(f.ports).coordinate(f.input)).toEqual({
        outcome: "unknown",
        refusal: "staged-import-plan-unavailable",
      });
      expect(f.policyReads).toEqual([]);
      expect(f.starts).toEqual([]);
      expect(f.dispatch).not.toHaveBeenCalled();
      const journal = await f.journal.read(f.input.connectionId);
      expect(journal.reservations[0]).toMatchObject({ phase: "prepared" });
      expect(journal.reservations[0].stagedImport).toBeUndefined();
    },
  );
  it.each([
    [["read", "read", "read"]],
    [["read", "mutation", "mutation"]],
    [["mutation", "mutation", "mutation"]],
  ] as const)("correctly marked %j plans dispatch unchanged", async (kinds) => {
    const f = await floorFixture([1000, 1000, 1000], kinds);
    expect(await createConnectorOperationCoordinator(f.ports).coordinate(f.input)).toEqual({
      outcome: "ok",
      pollWindowSeconds: 60,
    });
    expect(f.starts).toEqual([60000, 120000, 180000]);
    expect(f.policyReads).toHaveLength(4);
    expect((await f.journal.read(f.input.connectionId)).reservations[0]).toMatchObject({
      phase: "acked",
      stagedImport: { state: "released", requestIndex: 3 },
    });
  });
  it.each([
    [
      "unknown",
      "unknown-kind bypass",
      ['ids.has(id) || (hop.kind !== "read" && hop.kind !== "mutation")', "ids.has(id)"],
    ],
    [
      "missing",
      "missing-kind default",
      [
        'closedRecord(request, ["requestId", "kind", "maximumDurationMs"])',
        'closedRecord({ kind: "read", ...(request as object) }, ["requestId", "kind", "maximumDurationMs"])',
      ],
    ],
  ] as const)("%s kind: the %s mutant reaches the provider sink", async (defect, _name, edit) => {
    for (const bypass of [false, true]) {
      const f = await defective(defect);
      const create = bypass
        ? mutatedStagedImport({ fit: [edit] }).createConnectorOperationCoordinator
        : createConnectorOperationCoordinator;
      await create(f.ports).coordinate(f.input);
      expect(f.starts).toEqual(bypass ? [60000, 120000, 180000] : []);
    }
  });
});
