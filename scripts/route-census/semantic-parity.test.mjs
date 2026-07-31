import { beforeAll, describe, expect, it } from "vitest";
import { compareCaptures } from "./comparison.mts";
import { clone, makeCapture, rehashCapture, syntheticContext } from "./test-support.mjs";

let context;

beforeAll(async () => {
  context = await syntheticContext();
});

describe("deterministic semantic parity", () => {
  it("treats a positional-to-keyed-only transition as empty", async () => {
    const base = await makeCapture(context);
    const candidate = clone(base);
    candidate.mountRecords.forEach((mount) => {
      mount.entryShape = "keyed";
      mount.declaredContextMountOrdinal = mount.contextMountOrdinal;
    });
    candidate.censusRows.forEach((row) => {
      row.declaredContextMountOrdinal = row.contextMountOrdinal;
    });
    rehashCapture(candidate);
    expect(compareCaptures(base, candidate, "empty")).toMatchObject({
      actualState: "empty",
      countDiffs: [],
      mountDiffs: [],
      censusDiffs: [],
      duplicateGroupDiffs: [],
      assemblyDiffs: [],
    });
  });

  it("reports a router-expression reorder without index or group cascade", async () => {
    const base = await makeCapture(context, { routes: ["/first", "/middle", "/third"] });
    const candidate = await makeCapture(context, { routes: ["/third", "/middle", "/first"] });
    const comparison = compareCaptures(base, candidate, "nonempty");
    expect(comparison.actualState).toBe("nonempty");
    expect(comparison.censusDiffs.map(({ kind }) => kind)).toEqual(["removed", "removed", "added", "added"]);
    expect(comparison.duplicateGroupDiffs).toEqual([]);
    expect(comparison.censusDiffs.every(({ changedFields }) => changedFields.length === 0)).toBe(true);
  });

  it("reports a host-only pre-mount route insertion only in assembly", async () => {
    const base = await makeCapture(context);
    const candidate = clone(base);
    candidate.assemblyRows.splice(1, 0, {
      rowIndex: 2,
      basePath: "/",
      path: "/host-extra",
      method: "GET",
      handler: {
        referenceId: "H9999",
        name: "extra",
        arity: 1,
        constructorName: "Function",
        sourceSha256: "f".repeat(64),
      },
      sourceCensusRowIndex: null,
      sameHandlerReference: null,
    });
    candidate.assemblyRows.slice(2).forEach((row, index) => {
      row.rowIndex = index + 3;
    });
    candidate.mountedBlockStart += 1;
    candidate.counts.assemblyRecords += 1;
    candidate.counts.preMountRecords += 1;
    rehashCapture(candidate);
    const comparison = compareCaptures(base, candidate, "nonempty");
    expect(comparison.censusDiffs).toEqual([]);
    expect(comparison.duplicateGroupDiffs).toEqual([]);
    expect(comparison.assemblyDiffs).toEqual([
      expect.objectContaining({ kind: "added", baseIndex: null, candidateIndex: 2 }),
    ]);
  });

  it("chooses removal before addition for equal-cost ambiguity", async () => {
    const base = await makeCapture(context, { routes: ["/a", "/b"] });
    const candidate = await makeCapture(context, { routes: ["/b", "/a"] });
    const kinds = compareCaptures(base, candidate, "nonempty").censusDiffs.map(({ kind }) => kind);
    expect(kinds[0]).toBe("removed");
  });
});
