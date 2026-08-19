import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectLeafDiffPaths,
  deriveTypeScriptOwnerContexts,
  typeScriptOwnerContextArtifactPath,
} from "./typescript-owner-context-derivation.mjs";
import {
  formatOwnerContextArtifactBytes,
  lockfileBoundArtifactPaths,
  regenerateLockfileBoundArtifactExitCodes,
  regenerateLockfileBoundArtifactFailureCodes,
  runLockfileBoundArtifactRegenerationCli,
} from "./regenerate-lockfile-bound-artifacts.mjs";
import { repoRoot } from "../lib/repo.mjs";

function repoBytes(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath));
}

function repoJson(relativePath) {
  return JSON.parse(repoBytes(relativePath).toString("utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function memoryTree(overrides = {}) {
  const files = new Map(
    Object.entries({
      [typeScriptOwnerContextArtifactPath]: repoBytes(typeScriptOwnerContextArtifactPath),
      ...overrides,
    }).map(([relativePath, bytes]) => [relativePath, Buffer.from(bytes)]),
  );
  const writes = [];
  return {
    files,
    writes,
    readBytes: (relativePath) => files.get(relativePath) ?? repoBytes(relativePath),
    writeBytes: (relativePath, bytes) => {
      writes.push(relativePath);
      files.set(relativePath, Buffer.from(bytes));
    },
  };
}

async function run(tree, options = {}) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runLockfileBoundArtifactRegenerationCli(
    {
      rootDir: repoRoot,
      readBytes: tree.readBytes,
      writeBytes: tree.writeBytes,
      ...options,
    },
    {
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    },
  );
  return { exitCode, stdout, stderr };
}

describe("lockfile-bound artifact regeneration", () => {
  it("is byte-idempotent on a clean tree", async () => {
    const tree = memoryTree();
    const firstOwnerSha = sha256(tree.readBytes(typeScriptOwnerContextArtifactPath));
    const clean = await run(tree);

    expect(clean.exitCode).toBe(regenerateLockfileBoundArtifactExitCodes.success);
    expect(clean.stderr).toBe("");
    expect(clean.stdout).toContain(`${typeScriptOwnerContextArtifactPath}: unchanged`);
    expect(tree.writes).toEqual([]);

    expect(sha256(tree.readBytes(typeScriptOwnerContextArtifactPath))).toBe(firstOwnerSha);
    const ownerBytes = tree.readBytes(typeScriptOwnerContextArtifactPath);
    expect(ownerBytes.includes(Buffer.from("\r"))).toBe(false);
    expect(
      formatOwnerContextArtifactBytes(
        ownerBytes,
        JSON.parse(ownerBytes.toString("utf8")),
        JSON.parse(ownerBytes.toString("utf8")),
      ),
    ).toEqual(ownerBytes);
    console.log("CLEAN IDEMPOTENCE", JSON.stringify({ clean: clean.stdout.trim().split("\n") }));
  });

  it("regenerates exactly the lockfile provenance chain through production builders", async () => {
    const tree = memoryTree();
    const committedOwner = JSON.parse(tree.readBytes(typeScriptOwnerContextArtifactPath).toString("utf8"));
    const scratch = mkdtempSync(path.join(tmpdir(), "lockfile-bound-regeneration-"));
    const scratchLockfile = path.join(scratch, "pnpm-lock.yaml");
    try {
      writeFileSync(
        scratchLockfile,
        Buffer.concat([repoBytes("pnpm-lock.yaml"), Buffer.from("\n# dependency-only provenance perturbation\n")]),
      );
      const deriveFromScratchLockfile = ({ resolutionRoot, lockfilePath }) => {
        const derived = deriveTypeScriptOwnerContexts({ resolutionRoot, lockfilePath });
        derived.resolution.lockfilePath = committedOwner.resolution.lockfilePath;
        return derived;
      };
      const result = await run(tree, {
        lockfilePath: scratchLockfile,
        deriveArtifact: deriveFromScratchLockfile,
      });

      expect(result.exitCode).toBe(regenerateLockfileBoundArtifactExitCodes.success);
      expect(result.stderr).toBe("");
      expect(tree.writes).toEqual(lockfileBoundArtifactPaths);
      const generatedOwner = JSON.parse(tree.readBytes(typeScriptOwnerContextArtifactPath).toString("utf8"));
      const ownerLeafDiff = collectLeafDiffPaths(committedOwner, generatedOwner);
      expect(ownerLeafDiff).toEqual(["resolution.lockfileSha256"]);
      expect(generatedOwner.resolution.lockfileSha256).toBe(sha256(readFileSync(scratchLockfile)));

      const writesAfterFirstRun = tree.writes.length;
      const second = await run(tree, {
        lockfilePath: scratchLockfile,
        deriveArtifact: deriveFromScratchLockfile,
      });
      expect(second.exitCode).toBe(regenerateLockfileBoundArtifactExitCodes.success);
      expect(tree.writes).toHaveLength(writesAfterFirstRun);
      expect(second.stdout).toContain(`${typeScriptOwnerContextArtifactPath}: unchanged`);
      console.log(
        "LOCKFILE PROVENANCE CHAIN",
        JSON.stringify({
          ownerLeafDiff,
          lockfileSha256: generatedOwner.resolution.lockfileSha256,
        }),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("refuses semantic movement with a named exit and zero writes", async () => {
    const tree = memoryTree();
    const before = new Map(
      lockfileBoundArtifactPaths.map((relativePath) => [relativePath, tree.readBytes(relativePath)]),
    );
    const semanticMutant = repoJson(typeScriptOwnerContextArtifactPath);
    semanticMutant.runtimeSetHash = "0".repeat(64);
    const result = await run(tree, { deriveArtifact: () => semanticMutant });

    expect(result.exitCode).toBe(regenerateLockfileBoundArtifactExitCodes.semanticMovement);
    expect(result.exitCode).not.toBe(regenerateLockfileBoundArtifactExitCodes.success);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(regenerateLockfileBoundArtifactFailureCodes.semanticMovement);
    expect(result.stderr).toContain("runtimeSetHash");
    expect(tree.writes).toEqual([]);
    for (const relativePath of lockfileBoundArtifactPaths) {
      expect(tree.readBytes(relativePath)).toEqual(before.get(relativePath));
    }
    console.log(
      "SEMANTIC REFUSAL MUTANT",
      JSON.stringify({
        control: "semantic movement must take the refusal branch",
        observedExit: result.exitCode,
        transcript: result.stderr.trim(),
        writes: tree.writes,
      }),
    );
  });

  it("keeps the write scope and root command exact", () => {
    const packageJson = repoJson("package.json");
    expect(lockfileBoundArtifactPaths).toEqual(["scripts/check-structure/typescript-owner-contexts.json"]);
    expect(packageJson.scripts["regenerate:lockfile-bound-artifacts"]).toBe(
      "node ./scripts/check-structure/regenerate-lockfile-bound-artifacts.mjs",
    );
    console.log(
      "WRITE SCOPE BINDING",
      JSON.stringify({
        permittedWrites: lockfileBoundArtifactPaths,
        rootCommand: packageJson.scripts["regenerate:lockfile-bound-artifacts"],
      }),
    );
  });
});
