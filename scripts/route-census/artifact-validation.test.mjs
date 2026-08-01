import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { validateArtifactObject } from "./artifact.mts";
import { sha256 } from "./target-authority.mts";
import { clone, makeArtifact, rehashArtifact, rehashCapture } from "./test-support.mjs";
import { legacyApiContextRegistrySourcePath } from "./registry-source.mts";

let valid;
let context;
let expectations;
const unitValidation = { verifyLiveProvenance: false, requireCleanTrees: false, allowSameRootForTests: true };

beforeAll(async () => {
  ({ artifact: valid, context } = await makeArtifact());
  expectations = { baseHead: context.head, candidateHead: context.head, harnessHead: context.head };
});

async function refused(mutator, expectedCode = "E_ARTIFACT_INVALID") {
  const mutant = clone(valid);
  mutator(mutant);
  rehashArtifact(mutant);
  await expect(validateArtifactObject(mutant, expectations, unitValidation)).rejects.toMatchObject({
    code: expectedCode,
  });
}

describe("complete recursively closed v4 artifact", () => {
  it("requires separately rooted base and candidate captures outside the synthetic test seam", async () => {
    await expect(
      validateArtifactObject(valid, expectations, { verifyLiveProvenance: false, requireCleanTrees: false }),
    ).rejects.toMatchObject({ code: "E_ARTIFACT_INVALID" });
  });

  it("accepts valid twins and a valid zero-route mount partition", async () => {
    await expect(validateArtifactObject(valid, expectations, unitValidation)).resolves.toEqual(valid);
    const { artifact: zeroRoute } = await makeArtifact({ zeroRouteMount: true });
    await expect(validateArtifactObject(zeroRoute, expectations, unitValidation)).resolves.toEqual(zeroRoute);
  });

  it("rejects the legacy registry path on the candidate side while accepting it on the base side", async () => {
    const candidateLegacy = clone(valid);
    candidateLegacy.candidate.provenance.sourceFiles = clone(candidateLegacy.candidate.provenance.sourceFiles);
    candidateLegacy.candidate.provenance.sourceFiles[0].relativePath = legacyApiContextRegistrySourcePath;
    rehashCapture(candidateLegacy.candidate);
    rehashArtifact(candidateLegacy);
    await expect(validateArtifactObject(candidateLegacy, expectations, unitValidation)).rejects.toThrow(
      /candidate.*moved API context registry path/,
    );

    const baseLegacy = clone(valid);
    baseLegacy.base.provenance.sourceFiles = clone(baseLegacy.base.provenance.sourceFiles);
    baseLegacy.base.provenance.sourceFiles[0].relativePath = legacyApiContextRegistrySourcePath;
    rehashCapture(baseLegacy.base);
    rehashArtifact(baseLegacy);
    await expect(validateArtifactObject(baseLegacy, expectations, unitValidation)).resolves.toEqual(baseLegacy);
  });

  it.each([
    [
      "nested unknown",
      (artifact) => {
        artifact.base.censusRows[0].handler.surprise = true;
      },
    ],
    [
      "date only",
      (artifact) => {
        artifact.base.provenance.capturedAt = "2026-07-31";
      },
    ],
    [
      "out of range duration",
      (artifact) => {
        artifact.base.provenance.durationMs = 86_400_001;
      },
    ],
    [
      "wrong nested type",
      (artifact) => {
        artifact.base.counts.mounts = "1";
      },
    ],
  ])("rejects recursively closed schema mutant: %s", async (_name, mutate) => refused(mutate));

  it.each([
    [
      "contexts",
      (artifact) => {
        artifact.base.counts.contexts += 1;
      },
    ],
    [
      "mounts",
      (artifact) => {
        artifact.base.counts.mounts += 1;
      },
    ],
    [
      "routers",
      (artifact) => {
        artifact.base.counts.routers += 1;
      },
    ],
    [
      "distinctMountPaths",
      (artifact) => {
        artifact.base.counts.distinctMountPaths += 1;
      },
    ],
    [
      "zeroRouteMounts",
      (artifact) => {
        artifact.base.counts.zeroRouteMounts += 1;
      },
    ],
    [
      "censusRecords",
      (artifact) => {
        artifact.base.counts.censusRecords += 1;
      },
    ],
    [
      "censusAllRecords",
      (artifact) => {
        artifact.base.counts.censusAllRecords += 1;
      },
    ],
    [
      "assemblyRecords",
      (artifact) => {
        artifact.base.counts.assemblyRecords += 1;
      },
    ],
    [
      "assemblyAllRecords",
      (artifact) => {
        artifact.base.counts.assemblyAllRecords += 1;
      },
    ],
    [
      "preMountRecords",
      (artifact) => {
        artifact.base.counts.preMountRecords += 1;
      },
    ],
    [
      "scanned",
      (artifact) => {
        artifact.base.counts.scanned += 1;
      },
    ],
    [
      "total",
      (artifact) => {
        artifact.base.counts.total += 1;
      },
    ],
  ])("rejects derived count mutant: %s", async (_name, mutate) => refused(mutate));

  it.each([
    [
      "combinedPath",
      (artifact) => {
        artifact.base.censusRows[0].combinedPath += "/";
      },
    ],
    [
      "acceptedPath",
      (artifact) => {
        artifact.base.censusRows[0].acceptedPathProjections[0].acceptedPath += "/";
      },
    ],
    [
      "collisionPath",
      (artifact) => {
        artifact.base.censusRows[0].acceptedPathProjections[0].collisionPath += "/";
      },
    ],
    [
      "collisionShape",
      (artifact) => {
        artifact.base.censusRows[0].collisionShape[0] += "/";
      },
    ],
  ])("rejects retained collision projection tamper: %s", async (_name, mutate) => refused(mutate));

  it.each([
    [
      "occurrence count",
      (artifact) => {
        artifact.base.duplicateGroups[0].memberOccurrences[0].count += 1;
      },
    ],
    [
      "group key",
      (artifact) => {
        artifact.base.duplicateGroups[0].collisionShape[0] += "/wrong";
      },
    ],
    [
      "group omission",
      (artifact) => {
        artifact.base.duplicateGroups = [];
      },
    ],
    [
      "group invention",
      (artifact) => {
        artifact.base.duplicateGroups.push(clone(artifact.base.duplicateGroups[0]));
      },
    ],
    [
      "member row index bypass",
      (artifact) => {
        artifact.base.duplicateGroups[0].memberOccurrences[0].rowIndex = 1;
      },
    ],
  ])("rejects stable-group closure mutant: %s", async (_name, mutate) => refused(mutate));

  it("rejects misordered groups", async () => {
    const { artifact } = await makeArtifact({ routes: ["/a/:id", "/a/:slug", "/z/:id", "/z/:slug"] });
    const mutant = clone(artifact);
    mutant.base.duplicateGroups.reverse();
    rehashArtifact(mutant);
    await expect(validateArtifactObject(mutant, expectations, unitValidation)).rejects.toMatchObject({
      code: "E_ARTIFACT_INVALID",
    });
  });

  it.each([
    [
      "wrong kind",
      (artifact) => {
        artifact.comparison.duplicateGroupDiffs[0].kind = "added";
      },
    ],
    [
      "omitted",
      (artifact) => {
        artifact.comparison.duplicateGroupDiffs = [];
      },
    ],
    [
      "spurious",
      (artifact) => {
        artifact.comparison.duplicateGroupDiffs.push(clone(artifact.comparison.duplicateGroupDiffs[0]));
      },
    ],
    [
      "duplicate key",
      (artifact) => {
        artifact.comparison.duplicateGroupDiffs.push(clone(artifact.comparison.duplicateGroupDiffs[0]));
      },
    ],
    [
      "actual state",
      (artifact) => {
        artifact.comparison.actualState = "empty";
      },
    ],
  ])("rejects complete comparison mutant: %s", async (_name, mutate) => {
    const { artifact: changed } = await makeArtifact({}, { routes: ["/items/:id"] }, "nonempty");
    const mutant = clone(changed);
    mutate(mutant);
    rehashArtifact(mutant);
    await expect(validateArtifactObject(mutant, expectations, unitValidation)).rejects.toMatchObject({
      code: "E_ARTIFACT_INVALID",
    });
  });

  it("rejects reordered group diffs", async () => {
    const { artifact: changed } = await makeArtifact(
      { routes: ["/a/:id", "/a/:slug", "/z/:id", "/z/:slug"] },
      { routes: ["/b/:id", "/b/:slug", "/y/:id", "/y/:slug"] },
      "nonempty",
    );
    expect(changed.comparison.duplicateGroupDiffs.length).toBeGreaterThan(1);
    const mutant = clone(changed);
    mutant.comparison.duplicateGroupDiffs.reverse();
    rehashArtifact(mutant);
    await expect(validateArtifactObject(mutant, expectations, unitValidation)).rejects.toMatchObject({
      code: "E_ARTIFACT_INVALID",
    });
  });

  it.each([
    [
      "mount index",
      (artifact) => {
        artifact.base.mountRecords[0].mountIndex = 2;
      },
    ],
    [
      "row start",
      (artifact) => {
        artifact.base.mountRecords[0].rowStart = 2;
      },
    ],
    [
      "zero-route mapping",
      (artifact) => {
        artifact.base.mountRecords[0].routeCount = 0;
      },
    ],
    [
      "D-A8 boundary",
      (artifact) => {
        artifact.base.mountedBlockStart = 0;
      },
    ],
    [
      "D-A8 tail reference",
      (artifact) => {
        artifact.base.assemblyRows[1].sameHandlerReference = false;
      },
    ],
    [
      "false pre-mount qualifier",
      (artifact) => {
        artifact.base.assemblyRows[0].basePath = "/api";
      },
    ],
  ])("rejects partition/boundary mutant: %s", async (_name, mutate) => refused(mutate));

  it("rejects provenance authority, head, root, and shared-vector tampering", async () => {
    await refused((artifact) => {
      artifact.base.provenance.honoAuthority.packageVersion = "0.0.0";
    });
    const wrongHead = clone(valid);
    wrongHead.base.provenance.head = "f".repeat(40);
    rehashCapture(wrongHead.base);
    rehashArtifact(wrongHead);
    await expect(validateArtifactObject(wrongHead, expectations, unitValidation)).rejects.toMatchObject({
      code: "E_HEAD_MISMATCH",
    });
    const wrongRoot = clone(valid);
    wrongRoot.base.provenance.root = path.join(context.root, "missing-root");
    rehashCapture(wrongRoot.base);
    rehashArtifact(wrongRoot);
    await expect(validateArtifactObject(wrongRoot, expectations, unitValidation)).rejects.toMatchObject({
      code: "E_PROVENANCE",
    });
    await refused((artifact) => {
      artifact.collisionVector.cases[0].combinedPath = "/wrong";
    });
  });

  it("rejects old schemas without fabricating lineage", async () => {
    const mutant = clone(valid);
    mutant.schemaVersion = "chase-sets-route-parity/v3";
    await expect(validateArtifactObject(mutant, expectations, unitValidation)).rejects.toMatchObject({
      code: "E_SCHEMA_MISMATCH",
    });
  });

  it("rejects primitive hash and complete content hash tampering", async () => {
    const primitive = clone(valid);
    primitive.base.primitiveSha256 = sha256("wrong");
    rehashArtifact(primitive);
    await expect(validateArtifactObject(primitive, expectations, unitValidation)).rejects.toMatchObject({
      code: "E_ARTIFACT_INVALID",
    });

    const content = clone(valid);
    content.contentSha256 = sha256("wrong");
    await expect(validateArtifactObject(content, expectations, unitValidation)).rejects.toMatchObject({
      code: "E_ARTIFACT_INVALID",
    });
  });
});
