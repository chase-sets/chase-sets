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

async function runAgainstScratchLockfile(tree, lockfileBytes) {
  const scratch = mkdtempSync(path.join(tmpdir(), "lockfile-bound-regeneration-"));
  const scratchLockfile = path.join(scratch, "pnpm-lock.yaml");
  const committedLockfilePath = repoJson(typeScriptOwnerContextArtifactPath).resolution.lockfilePath;
  try {
    writeFileSync(scratchLockfile, lockfileBytes);
    const deriveFromScratchLockfile = ({ resolutionRoot, lockfilePath }) => {
      const derived = deriveTypeScriptOwnerContexts({ resolutionRoot, lockfilePath });
      derived.resolution.lockfilePath = committedLockfilePath;
      return derived;
    };
    return await run(tree, { lockfilePath: scratchLockfile, deriveArtifact: deriveFromScratchLockfile });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function committedArtifactBytes(artifact) {
  return Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
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

  it("stays byte-idempotent across two independent dependency branches and their merge", async () => {
    const lockfile = repoBytes("pnpm-lock.yaml");
    const branchA = Buffer.from("\n  dependency-branch-a@1.0.0: {}\n");
    const branchB = Buffer.from("\n  dependency-branch-b@2.0.0: {}\n");
    const lockfiles = {
      branchA: Buffer.concat([lockfile, branchA]),
      branchB: Buffer.concat([lockfile, branchB]),
      merged: Buffer.concat([lockfile, branchA, branchB]),
    };
    const receipts = [];
    for (const [name, bytes] of Object.entries(lockfiles)) {
      const tree = memoryTree();
      const committedOwnerSha = sha256(tree.readBytes(typeScriptOwnerContextArtifactPath));
      const result = await runAgainstScratchLockfile(tree, bytes);

      expect(sha256(bytes)).not.toBe(sha256(lockfile));
      expect(result.exitCode).toBe(regenerateLockfileBoundArtifactExitCodes.success);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("lockfile-bound-artifact-moved-leaves=[]");
      expect(result.stdout).toContain(`${typeScriptOwnerContextArtifactPath}: unchanged`);
      expect(tree.writes).toEqual([]);
      expect(sha256(tree.readBytes(typeScriptOwnerContextArtifactPath))).toBe(committedOwnerSha);
      receipts.push({ lockfile: name, lockfileSha256: sha256(bytes), ownerSha256: committedOwnerSha });
    }
    expect(new Set(receipts.map(({ lockfileSha256 }) => lockfileSha256)).size).toBe(3);
    expect(new Set(receipts.map(({ ownerSha256 }) => ownerSha256)).size).toBe(1);
    console.log("INDEPENDENT DEPENDENCY BRANCHES", JSON.stringify(receipts));
  });

  it("regenerates exactly the lockfile provenance chain through production builders", async () => {
    const tree = memoryTree();
    const committedOwner = JSON.parse(tree.readBytes(typeScriptOwnerContextArtifactPath).toString("utf8"));
    const aliasConsumer =
      "\n  alias-consumer@1.0.0:\n    dependencies:\n      typescript-api: '@typescript/typescript6@6.0.2'\n";
    const perturbed = Buffer.concat([repoBytes("pnpm-lock.yaml"), Buffer.from(aliasConsumer)]);
    const result = await runAgainstScratchLockfile(tree, perturbed);

    expect(result.exitCode).toBe(regenerateLockfileBoundArtifactExitCodes.success);
    expect(result.stderr).toBe("");
    expect(tree.writes).toEqual(lockfileBoundArtifactPaths);
    const generatedOwner = JSON.parse(tree.readBytes(typeScriptOwnerContextArtifactPath).toString("utf8"));
    const ownerLeafDiff = collectLeafDiffPaths(committedOwner, generatedOwner);
    expect(ownerLeafDiff).toEqual(["resolution.lockfileKeys"]);
    expect(generatedOwner.resolution.lockfileKeys).toEqual(
      committedOwner.resolution.lockfileKeys.map((entry) =>
        entry.key === "typescript-api:" ? { ...entry, occurrences: entry.occurrences + 1 } : entry,
      ),
    );

    const writesAfterFirstRun = tree.writes.length;
    const second = await runAgainstScratchLockfile(tree, perturbed);
    expect(second.exitCode).toBe(regenerateLockfileBoundArtifactExitCodes.success);
    expect(tree.writes).toHaveLength(writesAfterFirstRun);
    expect(second.stdout).toContain(`${typeScriptOwnerContextArtifactPath}: unchanged`);
    console.log(
      "LOCKFILE PROVENANCE CHAIN",
      JSON.stringify({ ownerLeafDiff, lockfileKeys: generatedOwner.resolution.lockfileKeys }),
    );
  });

  it("refuses forged, modified, malformed, and incomplete committed artifacts with zero writes", async () => {
    const forged = repoJson(typeScriptOwnerContextArtifactPath);
    forged.resolution.lockfileSha256 = sha256(repoBytes("pnpm-lock.yaml"));
    const modified = repoJson(typeScriptOwnerContextArtifactPath);
    modified.resolution.implementationSourceSha256 = "0".repeat(64);
    const malformed = repoJson(typeScriptOwnerContextArtifactPath);
    malformed.workspace.packageSha256 = "not-a-hash";
    const incomplete = repoJson(typeScriptOwnerContextArtifactPath);
    delete incomplete.resolution.lockfileKeys;
    const controls = [
      {
        name: "forged superseded whole-lockfile pin",
        artifact: forged,
        named: ["resolution.lockfileSha256", "derivation-artifact-field-unclassified"],
      },
      { name: "modified semantic leaf", artifact: modified, named: ["resolution.implementationSourceSha256"] },
      { name: "malformed member", artifact: malformed, named: ["derivation-artifact-schema-invalid"] },
      { name: "incomplete member set", artifact: incomplete, named: ["derivation-artifact-schema-invalid"] },
    ];

    const receipts = [];
    for (const control of controls) {
      const committedBytes = committedArtifactBytes(control.artifact);
      const tree = memoryTree({ [typeScriptOwnerContextArtifactPath]: committedBytes });
      const result = await run(tree);

      expect(result.exitCode, control.name).toBe(regenerateLockfileBoundArtifactExitCodes.semanticMovement);
      expect(result.stdout, control.name).toBe("");
      expect(result.stderr, control.name).toContain(regenerateLockfileBoundArtifactFailureCodes.semanticMovement);
      for (const named of control.named) expect(result.stderr, control.name).toContain(named);
      expect(tree.writes, control.name).toEqual([]);
      expect(tree.readBytes(typeScriptOwnerContextArtifactPath), control.name).toEqual(committedBytes);
      receipts.push({ control: control.name, observedExit: result.exitCode, transcript: result.stderr.trim() });
    }

    const unparseable = memoryTree({ [typeScriptOwnerContextArtifactPath]: Buffer.from('{ "contractVersion": ') });
    await expect(run(unparseable)).rejects.toThrow(SyntaxError);
    expect(unparseable.writes).toEqual([]);
    console.log("COMMITTED ARTIFACT REFUSALS", JSON.stringify(receipts));
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
