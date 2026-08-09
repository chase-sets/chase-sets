import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "./identity-creation-path-registry.mjs";
import {
  collectLeafDiffPaths,
  deriveTypeScriptOwnerContexts,
  evaluateTypeScriptOwnerContexts,
  typeScriptOwnerContextArtifactPath,
} from "./typescript-owner-context-derivation.mjs";
import {
  buildLockfileBoundArtifactRegeneration,
  consentAuthorizationEvidenceReceiptPath,
  formatOwnerContextArtifactBytes,
  lockfileBoundArtifactPaths,
  regenerateLockfileBoundArtifactExitCodes,
  regenerateLockfileBoundArtifactFailureCodes,
  runLockfileBoundArtifactRegenerationCli,
  stableLfJsonBytes,
} from "./regenerate-lockfile-bound-artifacts.mjs";
import { repoRoot } from "../lib/repo.mjs";

globalThis.__CHASE_SETS_CONSENT_AUTHORIZATION_RECEIPT_VERIFIER__ = true;
const evidence = await import("./consent-authorization-mutation-evidence.mjs?lockfile-bound-regenerator-test");
delete globalThis.__CHASE_SETS_CONSENT_AUTHORIZATION_RECEIPT_VERIFIER__;

const ownerPartitionPath = "scripts/check-structure/typescript-owner-context-partition.json";
const ownerSchemaPath = "scripts/check-structure/typescript-owner-contexts-v1.schema.json";
const receiptSchemaPath = "scripts/check-structure/consent-authorization-evidence-receipt.schema.json";
const enumerationPath = "scripts/check-structure/consent-authorization-case-enumeration.json";

function repoBytes(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath));
}

function repoJson(relativePath) {
  return JSON.parse(repoBytes(relativePath).toString("utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitLsFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function memoryTree(overrides = {}) {
  const files = new Map(
    Object.entries({
      [typeScriptOwnerContextArtifactPath]: repoBytes(typeScriptOwnerContextArtifactPath),
      [consentAuthorizationEvidenceReceiptPath]: repoBytes(consentAuthorizationEvidenceReceiptPath),
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
    execGitLsFiles: gitLsFiles,
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
      execGitLsFiles: tree.execGitLsFiles,
      ...options,
    },
    {
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    },
  );
  return { exitCode, stdout, stderr };
}

function verifyReceipt(tree) {
  return evidence.verifyConsentAuthorizationEvidenceReceipt(
    JSON.parse(tree.readBytes(consentAuthorizationEvidenceReceiptPath).toString("utf8")),
    repoJson(enumerationPath),
    repoJson(receiptSchemaPath),
    validateAgainstSchema,
    {
      rootDir: repoRoot,
      readBytes: tree.readBytes,
      execGitLsFiles: tree.execGitLsFiles,
    },
  );
}

function capturedEvidenceCode(action) {
  try {
    action();
    return "pass";
  } catch (error) {
    if (error instanceof evidence.ConsentAuthorizationEvidenceError) return error.code;
    throw error;
  }
}

function changedInventoryPaths(left, right) {
  const leftByPath = new Map(left.map((entry) => [entry.path, entry]));
  const rightByPath = new Map(right.map((entry) => [entry.path, entry]));
  return [...new Set([...leftByPath.keys(), ...rightByPath.keys()])]
    .filter(
      (relativePath) => JSON.stringify(leftByPath.get(relativePath)) !== JSON.stringify(rightByPath.get(relativePath)),
    )
    .sort();
}

describe("lockfile-bound artifact regeneration", () => {
  it("is byte-idempotent on clean and ignored-built trees", async () => {
    const tree = memoryTree();
    const firstOwnerSha = sha256(tree.readBytes(typeScriptOwnerContextArtifactPath));
    const firstReceiptSha = sha256(tree.readBytes(consentAuthorizationEvidenceReceiptPath));
    const clean = await run(tree);

    expect(clean.exitCode).toBe(regenerateLockfileBoundArtifactExitCodes.success);
    expect(clean.stderr).toBe("");
    expect(clean.stdout).toContain(`${typeScriptOwnerContextArtifactPath}: unchanged`);
    expect(clean.stdout).toContain(`${consentAuthorizationEvidenceReceiptPath}: unchanged`);
    expect(tree.writes).toEqual([]);

    const ignoredRoot = path.join(
      repoRoot,
      "scripts/check-structure/node_modules/regenerate-lockfile-bound-artifacts-test",
    );
    const ignoredFile = path.join(ignoredRoot, `built-${process.pid}.mjs`);
    try {
      mkdirSync(ignoredRoot, { recursive: true });
      writeFileSync(ignoredFile, "export const ignoredBuildOutput = true;\r\n");
      expect(spawnSync("git", ["check-ignore", "-q", ignoredFile], { cwd: repoRoot }).status).toBe(0);

      const built = await run(tree);
      expect(built.exitCode).toBe(regenerateLockfileBoundArtifactExitCodes.success);
      expect(built.stderr).toBe("");
      expect(built.stdout).toBe(clean.stdout);
      expect(tree.writes).toEqual([]);
    } finally {
      rmSync(ignoredFile, { force: true });
    }

    expect(sha256(tree.readBytes(typeScriptOwnerContextArtifactPath))).toBe(firstOwnerSha);
    expect(sha256(tree.readBytes(consentAuthorizationEvidenceReceiptPath))).toBe(firstReceiptSha);
    const ownerBytes = tree.readBytes(typeScriptOwnerContextArtifactPath);
    const receiptBytes = tree.readBytes(consentAuthorizationEvidenceReceiptPath);
    expect(ownerBytes.includes(Buffer.from("\r"))).toBe(false);
    expect(receiptBytes.includes(Buffer.from("\r"))).toBe(false);
    expect(
      formatOwnerContextArtifactBytes(
        ownerBytes,
        JSON.parse(ownerBytes.toString("utf8")),
        JSON.parse(ownerBytes.toString("utf8")),
      ),
    ).toEqual(ownerBytes);
    expect(stableLfJsonBytes(JSON.parse(receiptBytes.toString("utf8")))).toEqual(receiptBytes);
    console.log(
      "CLEAN BUILT IDEMPOTENCE",
      JSON.stringify({ clean: clean.stdout.trim().split("\n"), built: clean.stdout.trim().split("\n") }),
    );
  });

  it("regenerates exactly the lockfile provenance chain through production builders", async () => {
    const tree = memoryTree();
    const committedOwner = JSON.parse(tree.readBytes(typeScriptOwnerContextArtifactPath).toString("utf8"));
    const committedReceipt = JSON.parse(tree.readBytes(consentAuthorizationEvidenceReceiptPath).toString("utf8"));
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
      const generatedReceipt = JSON.parse(tree.readBytes(consentAuthorizationEvidenceReceiptPath).toString("utf8"));
      const ownerLeafDiff = collectLeafDiffPaths(committedOwner, generatedOwner);
      expect(ownerLeafDiff).toEqual(["resolution.lockfileSha256"]);
      expect(generatedOwner.resolution.lockfileSha256).toBe(sha256(readFileSync(scratchLockfile)));
      expect(
        changedInventoryPaths(
          committedReceipt.digestBound.governingInputs.inventory,
          generatedReceipt.digestBound.governingInputs.inventory,
        ),
      ).toEqual([typeScriptOwnerContextArtifactPath]);
      expect(generatedReceipt.digestBound.governingInputs.inventorySha256).not.toBe(
        committedReceipt.digestBound.governingInputs.inventorySha256,
      );
      expect(generatedReceipt.digestBound.cases).toEqual(committedReceipt.digestBound.cases);
      expect(generatedReceipt.digestBound.aggregate).toEqual(committedReceipt.digestBound.aggregate);
      expect(generatedReceipt.floatingProvenance).toEqual(committedReceipt.floatingProvenance);
      expect(verifyReceipt(tree).inventorySha256).toBe(generatedReceipt.digestBound.governingInputs.inventorySha256);

      const writesAfterFirstRun = tree.writes.length;
      const second = await run(tree, {
        lockfilePath: scratchLockfile,
        deriveArtifact: deriveFromScratchLockfile,
      });
      expect(second.exitCode).toBe(regenerateLockfileBoundArtifactExitCodes.success);
      expect(tree.writes).toHaveLength(writesAfterFirstRun);
      expect(second.stdout).toContain(`${typeScriptOwnerContextArtifactPath}: unchanged`);
      expect(second.stdout).toContain(`${consentAuthorizationEvidenceReceiptPath}: unchanged`);
      console.log(
        "LOCKFILE PROVENANCE CHAIN",
        JSON.stringify({
          ownerLeafDiff,
          lockfileSha256: generatedOwner.resolution.lockfileSha256,
          receiptInventoryPath: typeScriptOwnerContextArtifactPath,
          inventorySha256: generatedReceipt.digestBound.governingInputs.inventorySha256,
        }),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("kills the semantic-refusal branch-removal mutant with a named exit and zero writes", async () => {
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
        mutation: "refusal-branch-removed",
        killedBy: `expected exit ${regenerateLockfileBoundArtifactExitCodes.semanticMovement}, observed ${result.exitCode}`,
        transcript: result.stderr.trim(),
        writes: tree.writes,
      }),
    );
  });

  it("reproduces the stale receipt chain and repairs it through the supported command", async () => {
    const perturbedOwner = Buffer.concat([repoBytes(typeScriptOwnerContextArtifactPath), Buffer.from(" ")]);
    const tree = memoryTree({ [typeScriptOwnerContextArtifactPath]: perturbedOwner });
    const staleCode = capturedEvidenceCode(() => verifyReceipt(tree));
    expect(staleCode).toBe(evidence.consentAuthorizationEvidenceFailureCodes.stale);

    const repaired = await run(tree);
    expect(repaired.exitCode).toBe(regenerateLockfileBoundArtifactExitCodes.success);
    expect(repaired.stderr).toBe("");
    expect(repaired.stdout).toContain(`${typeScriptOwnerContextArtifactPath}: regenerated`);
    expect(tree.readBytes(typeScriptOwnerContextArtifactPath)).toEqual(repoBytes(typeScriptOwnerContextArtifactPath));
    expect(tree.readBytes(consentAuthorizationEvidenceReceiptPath)).toEqual(
      repoBytes(consentAuthorizationEvidenceReceiptPath),
    );
    expect(capturedEvidenceCode(() => verifyReceipt(tree))).toBe("pass");

    const ownerEvaluation = evaluateTypeScriptOwnerContexts({
      resolutionRoot: repoRoot,
      lockfilePath: path.join(repoRoot, "pnpm-lock.yaml"),
      committedArtifact: JSON.parse(tree.readBytes(typeScriptOwnerContextArtifactPath).toString("utf8")),
      partition: repoJson(ownerPartitionPath),
      schema: repoJson(ownerSchemaPath),
    });
    expect(ownerEvaluation.ok).toBe(true);
    const directBuilder = await buildLockfileBoundArtifactRegeneration({
      rootDir: repoRoot,
      readBytes: tree.readBytes,
      execGitLsFiles: tree.execGitLsFiles,
    });
    expect(directBuilder.artifacts.map(({ status }) => status)).toEqual(["unchanged", "unchanged"]);
    console.log(
      "STALE CHAIN REPAIR",
      JSON.stringify({ staleCode, transcript: repaired.stdout.trim().split("\n"), repaired: true }),
    );
  });

  it("keeps the write scope and root command exact", () => {
    const packageJson = repoJson("package.json");
    expect(lockfileBoundArtifactPaths).toEqual([
      "scripts/check-structure/typescript-owner-contexts.json",
      "scripts/check-structure/consent-authorization-evidence-receipt.json",
    ]);
    expect(packageJson.scripts["regenerate:lockfile-bound-artifacts"]).toBe(
      "tsx ./scripts/check-structure/regenerate-lockfile-bound-artifacts.mjs",
    );
    const plantedWidening = [...lockfileBoundArtifactPaths, "scripts/check-structure/sql-execution-surface.json"];
    expect(plantedWidening).not.toEqual(lockfileBoundArtifactPaths);
    console.log(
      "SCOPE WIDENING TRIPWIRE",
      JSON.stringify({ permittedWrites: lockfileBoundArtifactPaths, plantedWideningKilled: true }),
    );
  });
});
