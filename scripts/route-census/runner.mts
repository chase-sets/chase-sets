import { execFile as execFileCallback, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHeavySlot } from "../lib/heavy-slot.mjs";
import {
  createArtifact,
  validateArtifactObject,
  type ArtifactExpectations,
  type HarnessProvenance,
  type RouteParityArtifact,
} from "./artifact.mts";
import { asRouteCensusError, fail, RouteCensusError, type RouteCensusErrorCode } from "./errors.mts";
import { parseJsonStrict } from "./strict-json.mts";
import { sha256 } from "./target-authority.mts";
import type { RouteCapture } from "./model.mts";

const execFile = promisify(execFileCallback);
const routeCensusDirectory = path.dirname(fileURLToPath(import.meta.url));
const harnessRootFromModule = path.resolve(routeCensusDirectory, "..", "..");
const childModulePath = path.join(routeCensusDirectory, "evaluate-child.mts");

export type ParityOptions = Readonly<{
  baseRoot: string;
  baseHead: string;
  candidateRoot: string;
  candidateHead: string;
  harnessHead: string;
  expectedState: "empty" | "nonempty";
  outputPath: string;
}>;

type Preflight = Readonly<{
  baseRoot: string;
  candidateRoot: string;
  harnessRoot: string;
  outputPath: string;
}>;

type ParityDependencies = Readonly<{
  preflight: (options: ParityOptions) => Promise<Preflight>;
  acquire: () => boolean;
  evaluate: (root: string, head: string) => Promise<RouteCapture>;
  reread: (preflight: Preflight, options: ParityOptions) => Promise<void>;
  harness: (preflight: Preflight, head: string) => Promise<HarnessProvenance>;
  validate: (artifact: RouteParityArtifact, expectations: ArtifactExpectations) => Promise<void>;
  publish: (outputPath: string, artifact: RouteParityArtifact) => Promise<void>;
}>;

async function git(root: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFile("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
    return result.stdout.trim();
  } catch {
    fail("E_ROOT_INVALID", `Git worktree query failed for '${root}'.`);
  }
}

async function canonicalCleanWorktree(rootInput: string, expectedHead: string, label: string): Promise<string> {
  let root: string;
  try {
    root = await realpath(path.resolve(rootInput));
    if (!(await lstat(root)).isDirectory()) throw new Error("not directory");
  } catch {
    fail("E_ROOT_INVALID", `${label} root is not a readable directory.`);
  }
  const gitRoot = await realpath(path.resolve(await git(root, ["rev-parse", "--show-toplevel"])));
  if (gitRoot !== root) fail("E_ROOT_INVALID", `${label} root is not the canonical Git worktree root.`);
  const actualHead = await git(root, ["rev-parse", "HEAD"]);
  if (actualHead !== expectedHead)
    fail("E_HEAD_MISMATCH", `${label} head '${actualHead}' does not match '${expectedHead}'.`);
  if (await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    fail("E_WORKTREE_DIRTY", `${label} worktree is dirty.`);
  }
  return root;
}

async function outputMustBeAbsent(outputPathInput: string): Promise<string> {
  const outputPath = path.resolve(outputPathInput);
  try {
    await lstat(outputPath);
    fail("E_OUTPUT_EXISTS", `Output already exists: '${outputPath}'.`);
  } catch (error) {
    if (error instanceof RouteCensusError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail("E_PUBLICATION_FAILED", `Output path cannot be preflighted: '${outputPath}'.`);
    }
  }
  let ancestor = path.dirname(outputPath);
  while (true) {
    try {
      const metadata = await lstat(ancestor);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        fail("E_PUBLICATION_FAILED", `Output ancestor is not a plain directory: '${ancestor}'.`);
      }
      await access(ancestor, constants.W_OK);
      break;
    } catch (error) {
      if (error instanceof RouteCensusError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        fail("E_PUBLICATION_FAILED", `Output ancestor is not writable: '${ancestor}'.`);
      }
      const next = path.dirname(ancestor);
      if (next === ancestor) fail("E_PUBLICATION_FAILED", `Output has no writable ancestor: '${outputPath}'.`);
      ancestor = next;
    }
  }
  return outputPath;
}

export async function preflightParity(options: ParityOptions): Promise<Preflight> {
  const baseRoot = await canonicalCleanWorktree(options.baseRoot, options.baseHead, "Base");
  const candidateRoot = await canonicalCleanWorktree(options.candidateRoot, options.candidateHead, "Candidate");
  const harnessRoot = await canonicalCleanWorktree(harnessRootFromModule, options.harnessHead, "Harness");
  if (baseRoot === candidateRoot)
    fail("E_ROOT_INVALID", "Base and candidate roots must be separately rooted worktrees.");
  const outputPath = await outputMustBeAbsent(options.outputPath);
  return { baseRoot, candidateRoot, harnessRoot, outputPath };
}

async function evaluateChild(root: string, expectedHead: string): Promise<RouteCapture> {
  return await new Promise<RouteCapture>((resolve, reject) => {
    const child = fork(childModulePath, [], {
      cwd: root,
      execArgv: process.execArgv,
      env: {
        ...process.env,
        NODE_ENV: "test",
        TSX_TSCONFIG_PATH: path.join(root, "tsconfig.json"),
        ROUTE_CENSUS_TARGET_ROOT: root,
        ROUTE_CENSUS_EXPECT_HEAD: expectedHead,
      },
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    let messageReceived = false;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.on("message", (message: unknown) => {
      if (messageReceived) {
        reject(new RouteCensusError("E_CHILD_FAILED", "Evaluation child emitted duplicate payloads."));
        return;
      }
      messageReceived = true;
      if (!message || typeof message !== "object") {
        reject(new RouteCensusError("E_CHILD_FAILED", "Evaluation child emitted a malformed payload."));
        return;
      }
      const payload = message as { ok?: unknown; capture?: unknown; code?: unknown; message?: unknown };
      if (payload.ok === true) resolve(payload.capture as RouteCapture);
      else {
        reject(
          new RouteCensusError(
            typeof payload.code === "string" ? (payload.code as RouteCensusErrorCode) : "E_CHILD_FAILED",
            typeof payload.message === "string" ? payload.message : "Evaluation child failed.",
          ),
        );
      }
    });
    child.on("error", (error) => reject(new RouteCensusError("E_CHILD_FAILED", error.message, { cause: error })));
    child.on("exit", (code) => {
      if (!messageReceived) {
        reject(
          new RouteCensusError(
            "E_CHILD_FAILED",
            `Evaluation child exited ${code ?? "without status"}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

async function reread(preflight: Preflight, options: ParityOptions): Promise<void> {
  await canonicalCleanWorktree(preflight.baseRoot, options.baseHead, "Base");
  await canonicalCleanWorktree(preflight.candidateRoot, options.candidateHead, "Candidate");
  await canonicalCleanWorktree(preflight.harnessRoot, options.harnessHead, "Harness");
}

async function harnessProvenance(preflight: Preflight, expectedHead: string): Promise<HarnessProvenance> {
  const runFile = await realpath(path.join(preflight.harnessRoot, "scripts", "route-census", "run.mts"));
  return {
    root: preflight.harnessRoot,
    head: expectedHead,
    runFile: {
      relativePath: "scripts/route-census/run.mts",
      realpath: runFile,
      sha256: sha256(await readFile(runFile)),
    },
  };
}

export async function publishArtifact(outputPath: string, artifact: RouteParityArtifact): Promise<void> {
  await outputMustBeAbsent(outputPath);
  const outputParent = path.dirname(outputPath);
  let firstCreatedDirectory: string | undefined;
  try {
    firstCreatedDirectory = await mkdir(outputParent, { recursive: true });
  } catch (error) {
    throw asRouteCensusError(error, "E_PUBLICATION_FAILED");
  }
  const temporaryPath = path.join(outputParent, `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await outputMustBeAbsent(outputPath);
    await rename(temporaryPath, outputPath);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Publication already fails closed below.
      }
    }
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RouteCensusError(
          "E_PUBLICATION_FAILED",
          `Temporary artifact cleanup failed: ${String(cleanupError)}.`,
          {
            cause: error,
          },
        );
      }
    }
    if (firstCreatedDirectory) {
      let ownedDirectory = outputParent;
      const boundary = path.dirname(firstCreatedDirectory);
      while (ownedDirectory !== boundary) {
        try {
          await rmdir(ownedDirectory);
        } catch {
          break;
        }
        ownedDirectory = path.dirname(ownedDirectory);
      }
    }
    throw asRouteCensusError(error, "E_PUBLICATION_FAILED");
  }
}

const defaultDependencies: ParityDependencies = {
  preflight: preflightParity,
  acquire: () => acquireHeavySlot("script-battery", { startDirectory: harnessRootFromModule }),
  evaluate: evaluateChild,
  reread,
  harness: harnessProvenance,
  validate: async (artifact, expectations) => {
    await validateArtifactObject(artifact, expectations, {
      requireCleanTrees: true,
      verifyLiveProvenance: true,
      allowExpectationMismatchForParity: true,
    });
  },
  publish: publishArtifact,
};

export async function runParity(
  options: ParityOptions,
  dependencies: ParityDependencies = defaultDependencies,
): Promise<RouteParityArtifact> {
  const preflight = await dependencies.preflight(options);
  process.chdir(preflight.harnessRoot);
  if (!dependencies.acquire()) fail("E_SLOT_CLIENT_UNAVAILABLE", "Heavy-slot client is unavailable.");
  const base = await dependencies.evaluate(preflight.baseRoot, options.baseHead);
  const candidate = await dependencies.evaluate(preflight.candidateRoot, options.candidateHead);
  await dependencies.reread(preflight, options);
  const artifact = createArtifact(
    new Date().toISOString(),
    await dependencies.harness(preflight, options.harnessHead),
    base,
    candidate,
    options.expectedState,
  );
  const expectations = {
    baseHead: options.baseHead,
    candidateHead: options.candidateHead,
    harnessHead: options.harnessHead,
    baseRoot: preflight.baseRoot,
    candidateRoot: preflight.candidateRoot,
  };
  await dependencies.validate(artifact, expectations);
  if (artifact.comparison.actualState !== options.expectedState) {
    fail(
      "E_EXPECTATION_MISMATCH",
      `Expected comparison '${options.expectedState}' but recomputation was '${artifact.comparison.actualState}'.`,
    );
  }
  await dependencies.publish(preflight.outputPath, artifact);
  return artifact;
}

export async function readAndValidateArtifact(
  artifactPathInput: string,
  expectations: ArtifactExpectations,
): Promise<RouteParityArtifact> {
  const artifactPath = path.resolve(artifactPathInput);
  try {
    const metadata = await lstat(artifactPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("not a plain file");
  } catch {
    fail("E_ARTIFACT_INVALID", `Artifact path is not one exact plain payload file: '${artifactPath}'.`);
  }
  let parsed: unknown;
  try {
    parsed = parseJsonStrict(await readFile(artifactPath, "utf8"));
  } catch (error) {
    throw asRouteCensusError(error, "E_ARTIFACT_INVALID");
  }
  return await validateArtifactObject(parsed, expectations, { requireCleanTrees: true, verifyLiveProvenance: true });
}
