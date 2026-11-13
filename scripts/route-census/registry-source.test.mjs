import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateArtifactObject } from "./artifact.mts";
import {
  API_REGISTRY_SOURCE,
  API_REGISTRY_SOURCES,
  LEGACY_API_REGISTRY_SOURCE,
  assertRecordedApiRegistrySource,
  resolveApiRegistrySource,
} from "./registry-source.mts";
import { clone, makeArtifact, rehashArtifact, rehashCapture } from "./test-support.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A real Git worktree per case: resolution reads the target's own directory
// entries and index, never the harness checkout.
function gitTree(files, tracked = files) {
  const root = mkdtempSync(path.join(tmpdir(), "route-census-registry-source-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  for (const file of ["README.md", ...files]) {
    const filePath = path.join(root, ...file.split("/"));
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const apiContextRegistry = [];\n", "utf8");
  }
  execFileSync("git", ["-C", root, "add", "--", "README.md", ...tracked]);
  return root;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return { code: error.code, message: error.message };
  }
  throw new Error("expected a rejection");
}

describe("API context registry source resolution", () => {
  it("owns the closed legacy/current source list", () => {
    expect(API_REGISTRY_SOURCES).toEqual([
      "deployables/platform-api/src/generated/api-context-registry.ts",
      "deployables/platform-api/src/context-registry.ts",
    ]);
    expect([LEGACY_API_REGISTRY_SOURCE, API_REGISTRY_SOURCE]).toEqual(API_REGISTRY_SOURCES);
  });

  it("C1 rejects a root where both legacy and current sources resolve", async () => {
    const root = gitTree([LEGACY_API_REGISTRY_SOURCE, API_REGISTRY_SOURCE]);

    expect(await rejection(resolveApiRegistrySource(root))).toEqual({
      code: "E_PROVENANCE",
      message: expect.stringMatching(/^Both legacy and current API context registries resolve under /),
    });
  });

  it("C2 rejects a root where neither source resolves", async () => {
    const root = gitTree([]);

    expect(await rejection(resolveApiRegistrySource(root))).toEqual({
      code: "E_PROVENANCE",
      message: expect.stringMatching(/^No API context registry resolves under .*; expected exactly one of /),
    });
  });

  it.each([
    ["file", "deployables/platform-api/src/Context-Registry.ts"],
    ["directory", "deployables/Platform-API/src/context-registry.ts"],
  ])("C3 rejects a current source with a wrong-case %s segment", async (_segment, spelled) => {
    const root = gitTree([spelled]);

    expect(await rejection(resolveApiRegistrySource(root))).toEqual({
      code: "E_PROVENANCE",
      message: expect.stringContaining(`'${API_REGISTRY_SOURCE}' is spelled '${spelled}' under `),
    });
  });

  it("C4 rejects a legacy source with a wrong-case segment", async () => {
    const spelled = "deployables/platform-api/src/Generated/api-context-registry.ts";
    const root = gitTree([spelled]);

    expect(await rejection(resolveApiRegistrySource(root))).toEqual({
      code: "E_PROVENANCE",
      message: expect.stringContaining(`'${LEGACY_API_REGISTRY_SOURCE}' is spelled '${spelled}' under `),
    });
  });

  it("C5 resolves the current source from a native-separator root to a forward-slash path", async () => {
    const root = gitTree([API_REGISTRY_SOURCE]);
    const nativeRoot = `${process.platform === "win32" ? root.replaceAll("/", "\\") : root}${path.sep}`;

    const resolved = await resolveApiRegistrySource(nativeRoot);

    expect(resolved).toEqual({
      relativePath: "deployables/platform-api/src/context-registry.ts",
      absolutePath: path.join(realpathSync.native(root), "deployables", "platform-api", "src", "context-registry.ts"),
    });
    expect(resolved.relativePath).not.toContain("\\");
  });

  it("C6 admits a legacy source on the base side only", async () => {
    const root = gitTree([LEGACY_API_REGISTRY_SOURCE]);

    await expect(
      assertRecordedApiRegistrySource(root, "base", LEGACY_API_REGISTRY_SOURCE, "base.sourceFiles[0]"),
    ).resolves.toBeUndefined();
    expect(
      await rejection(
        assertRecordedApiRegistrySource(root, "candidate", LEGACY_API_REGISTRY_SOURCE, "candidate.sourceFiles[0]"),
      ),
    ).toEqual({
      code: "E_ARTIFACT_INVALID",
      message: "candidate.sourceFiles[0] is not an admitted candidate API context registry.",
    });

    const current = gitTree([API_REGISTRY_SOURCE]);
    for (const side of ["base", "candidate"]) {
      await expect(
        assertRecordedApiRegistrySource(current, side, API_REGISTRY_SOURCE, `${side}.sourceFiles[0]`),
      ).resolves.toBeUndefined();
    }
  });

  it("C7 rejects a recorded source that does not resolve under its recorded root", async () => {
    const current = gitTree([API_REGISTRY_SOURCE]);
    expect(
      await rejection(
        assertRecordedApiRegistrySource(current, "base", LEGACY_API_REGISTRY_SOURCE, "base.sourceFiles[0]"),
      ),
    ).toEqual({
      code: "E_PROVENANCE",
      message: `base.sourceFiles[0] does not resolve under its recorded root; '${API_REGISTRY_SOURCE}' does.`,
    });

    const legacy = gitTree([LEGACY_API_REGISTRY_SOURCE]);
    expect(
      await rejection(assertRecordedApiRegistrySource(legacy, "base", API_REGISTRY_SOURCE, "base.sourceFiles[0]")),
    ).toEqual({
      code: "E_PROVENANCE",
      message: `base.sourceFiles[0] does not resolve under its recorded root; '${LEGACY_API_REGISTRY_SOURCE}' does.`,
    });
  });

  it("does not authorize an existing but untracked source", async () => {
    const root = gitTree([API_REGISTRY_SOURCE], []);

    expect(await rejection(resolveApiRegistrySource(root))).toEqual({
      code: "E_PROVENANCE",
      message: expect.stringContaining(`'${API_REGISTRY_SOURCE}' is not Git-tracked with that spelling under `),
    });
  });

  it("does not authorize a source tracked outside the target root's own tree", async () => {
    const outer = gitTree([`nested/${API_REGISTRY_SOURCE}`]);

    expect(await rejection(resolveApiRegistrySource(path.join(outer, "nested")))).toEqual({
      code: "E_PROVENANCE",
      message: expect.stringContaining(`'${API_REGISTRY_SOURCE}' is not Git-tracked with that spelling under `),
    });
  });
});

describe("artifact registry source sides", () => {
  const unitValidation = { verifyLiveProvenance: false, requireCleanTrees: false, allowSameRootForTests: true };

  function withRegistrySource(artifact, side, relativePath) {
    const mutant = clone(artifact);
    // Synthetic base and candidate captures share one sourceFiles array.
    mutant[side].provenance.sourceFiles = mutant[side].provenance.sourceFiles.map((file, index) =>
      index === 0 ? { ...file, relativePath } : { ...file },
    );
    mutant[side] = rehashCapture(mutant[side]);
    return rehashArtifact(mutant);
  }

  it("C6 accepts a legacy base capture and rejects a legacy candidate capture", async () => {
    const { artifact, context } = await makeArtifact();
    const expectations = { baseHead: context.head, candidateHead: context.head, harnessHead: context.head };
    const legacyBase = withRegistrySource(artifact, "base", LEGACY_API_REGISTRY_SOURCE);
    const legacyCandidate = withRegistrySource(artifact, "candidate", LEGACY_API_REGISTRY_SOURCE);

    await expect(validateArtifactObject(legacyBase, expectations, unitValidation)).resolves.toEqual(legacyBase);
    await expect(validateArtifactObject(legacyCandidate, expectations, unitValidation)).rejects.toMatchObject({
      code: "E_ARTIFACT_INVALID",
      message: "artifact.candidate.provenance.sourceFiles[0] is not an admitted candidate API context registry.",
    });
  });

  it("C7 rejects a live capture whose recorded source does not resolve under its root", async () => {
    const { artifact, context } = await makeArtifact();
    const mutant = withRegistrySource(artifact, "base", LEGACY_API_REGISTRY_SOURCE);

    await expect(
      validateArtifactObject(
        mutant,
        { baseHead: context.head, candidateHead: context.head, harnessHead: context.head },
        { verifyLiveProvenance: true, requireCleanTrees: false, allowSameRootForTests: true },
      ),
    ).rejects.toMatchObject({
      code: "E_PROVENANCE",
      message: `artifact.base.provenance.sourceFiles[0] does not resolve under its recorded root; '${API_REGISTRY_SOURCE}' does.`,
    });
  });
});
