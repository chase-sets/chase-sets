import { describe, expect, it } from "vitest";
import { validateArtifactObject } from "./artifact.mts";
import { clone, makeArtifact, rehashArtifact, rehashCapture } from "./test-support.mjs";
import { legacyApiContextRegistrySourcePath } from "./registry-source.mts";

describe("exact head/root provenance", () => {
  it("accepts live Windows Git/root canonicalization without requiring a clean synthetic pair", async () => {
    const { artifact, context } = await makeArtifact();
    await expect(
      validateArtifactObject(
        artifact,
        { baseHead: context.head, candidateHead: context.head, harnessHead: context.head },
        { verifyLiveProvenance: true, requireCleanTrees: false, allowSameRootForTests: true },
      ),
    ).resolves.toEqual(artifact);
  });

  it("rejects wrong harness, base, and candidate expected heads", async () => {
    const { artifact, context } = await makeArtifact();
    const common = { verifyLiveProvenance: false, requireCleanTrees: false, allowSameRootForTests: true };
    await expect(
      validateArtifactObject(
        artifact,
        {
          baseHead: "f".repeat(40),
          candidateHead: context.head,
          harnessHead: context.head,
        },
        common,
      ),
    ).rejects.toMatchObject({ code: "E_HEAD_MISMATCH" });
    await expect(
      validateArtifactObject(
        artifact,
        {
          baseHead: context.head,
          candidateHead: "f".repeat(40),
          harnessHead: context.head,
        },
        common,
      ),
    ).rejects.toMatchObject({ code: "E_HEAD_MISMATCH" });
    await expect(
      validateArtifactObject(
        artifact,
        {
          baseHead: context.head,
          candidateHead: context.head,
          harnessHead: "f".repeat(40),
        },
        common,
      ),
    ).rejects.toMatchObject({ code: "E_HEAD_MISMATCH" });
  });

  it("rejects supplied root mismatches before accepting comparison", async () => {
    const { artifact, context } = await makeArtifact();
    await expect(
      validateArtifactObject(
        artifact,
        {
          baseHead: context.head,
          candidateHead: context.head,
          harnessHead: context.head,
          baseRoot: context.root,
          candidateRoot: `${context.root}-wrong`,
        },
        { verifyLiveProvenance: false, requireCleanTrees: false, allowSameRootForTests: true },
      ),
    ).rejects.toMatchObject({ code: "E_PROVENANCE" });
  });

  it("rejects capture-local position claims even when comparison ignores them", async () => {
    const { artifact, context } = await makeArtifact();
    const mutant = clone(artifact);
    mutant.base.censusRows[0].routeOrdinal = 99;
    await expect(
      validateArtifactObject(
        mutant,
        { baseHead: context.head, candidateHead: context.head, harnessHead: context.head },
        { verifyLiveProvenance: false, requireCleanTrees: false, allowSameRootForTests: true },
      ),
    ).rejects.toMatchObject({ code: "E_ARTIFACT_INVALID" });
  });

  it("rejects a recorded registry path that is not the path resolving under its own root", async () => {
    const { artifact, context } = await makeArtifact();
    const mutant = clone(artifact);
    mutant.base.provenance.sourceFiles = clone(mutant.base.provenance.sourceFiles);
    mutant.base.provenance.sourceFiles[0].relativePath = legacyApiContextRegistrySourcePath;
    rehashCapture(mutant.base);
    rehashArtifact(mutant);
    await expect(
      validateArtifactObject(
        mutant,
        { baseHead: context.head, candidateHead: context.head, harnessHead: context.head },
        { verifyLiveProvenance: true, requireCleanTrees: false, allowSameRootForTests: true },
      ),
    ).rejects.toMatchObject({ code: "E_PROVENANCE" });
  });
});
