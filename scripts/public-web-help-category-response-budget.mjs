import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { acquireHeavySlot, findHeavySlotClient } from "./lib/heavy-slot.mjs";
import { buildPackageManagerInvocation, terminateProcessTree } from "./lib/process.mjs";

export const EXPECTED_SALVAGE_HEAD = "7cd0210537b4ba352e77c5a168bf30dc9e4ae740";
const SHIPPED_RESPONSE_BOUND_BYTES = 122_727;

const routePath = "bounded-contexts/public-presence/routes/marketplace/help-category.tsx";
const cardPath = "bounded-contexts/public-presence/features/help/ui/help-pages.tsx";
const sourcePatchPaths = [routePath, cardPath];
const forbiddenMutantFailureReasons = [
  "status-5xx",
  "deadline-exceeded",
  "gate-deadline-exceeded",
  "strict-status",
  "strict-content-type",
  "strict-degraded-state",
];

export class HelpCategoryResponseBudgetError extends Error {
  constructor(code, message, options = {}) {
    super(`${code}: ${message}`, options);
    this.name = "HelpCategoryResponseBudgetError";
    this.code = code;
  }
}

function commandResult(child, capture) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function runProcess(spec) {
  const capture = spec.capture !== false;
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  return commandResult(child, capture);
}

function startProcess(spec) {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const handle = {
    id: spec.id,
    child,
    exited: false,
    stdout: "",
    stderr: "",
    completion: undefined,
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    handle.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    handle.stderr += chunk;
  });
  handle.completion = commandResult(child, false).then(
    (result) => {
      handle.exited = true;
      return result;
    },
    (error) => {
      handle.exited = true;
      return { code: null, signal: null, error };
    },
  );
  return handle;
}

async function terminateProcess(handle) {
  if (!handle || handle.exited) return false;
  const terminated = terminateProcessTree(handle.child);
  if (!terminated && handle.child.exitCode === null && handle.child.signalCode === null) {
    throw new Error(`unable to terminate process ${handle.id}`);
  }
  await handle.completion;
  return terminated;
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function defaultWorktreePath(containerRoot, randomId) {
  return path.join(containerRoot, `review-6441-${process.pid}-${randomId}`);
}

function createDefaultDependencies() {
  return {
    acquireHeavySlot,
    findHeavySlotClient,
    fetch: globalThis.fetch,
    readFile,
    pathExists,
    removePath: rm,
    writeFile,
    runProcess,
    startProcess,
    terminateProcess,
    buildPackageManagerInvocation,
    createWorktreePath: defaultWorktreePath,
    randomId: () => randomBytes(6).toString("hex"),
    temporaryDirectory: () => tmpdir(),
    now: () => new Date().toISOString(),
  };
}

function recordEffect(receipt, effect, onEffect) {
  receipt.effectLog.push(effect);
  onEffect?.(effect);
}

function normalizedPath(candidate) {
  return path.resolve(candidate).toLowerCase();
}

function assertExactLines(actual, expected, code, description) {
  const lines = actual
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(lines) !== JSON.stringify(sortedExpected)) {
    throw new HelpCategoryResponseBudgetError(
      code,
      `${description} was [${lines.join(", ")}], expected [${sortedExpected.join(", ")}].`,
    );
  }
}

function requireSuccess(result, code, description) {
  if (result.code !== 0) {
    throw new HelpCategoryResponseBudgetError(code, `${description} exited ${result.code ?? "without a code"}.`);
  }
  return result;
}

function pnpmCommand(args, { id, cwd, env, capture = false }, dependencies) {
  const invocation = dependencies.buildPackageManagerInvocation(args, { env });
  return {
    id,
    command: invocation.command,
    args: invocation.args,
    cwd,
    env,
    capture,
    display: `pnpm ${args.join(" ")}`,
  };
}

function gitCommand(args, { id, cwd, env, capture = true }) {
  return { id, command: "git", args, cwd, env, capture, display: `git ${args.join(" ")}` };
}

function redact(value, ownerToken) {
  return String(value ?? "")
    .split(ownerToken)
    .join("[redacted-heavy-owner-token]");
}

function ownerIdentityText(identity) {
  return `sha256:${identity.tokenDigest} pid=${identity.pid} processStartUtc=${identity.processStartUtc}`;
}

async function readOwnerIdentity(clientPath, environment, dependencies, receipt, onEffect) {
  const ownerToken = environment.CHASE_SETS_HEAVY_SLOT_ID;
  if (!/^[a-f0-9]{32}$/u.test(ownerToken ?? "")) {
    throw new HelpCategoryResponseBudgetError(
      "HEAVY_OWNER_IDENTITY_MISSING",
      "heavy admission did not publish a valid inherited owner token.",
    );
  }
  const ownerPath = path.join(path.dirname(clientPath), "verify-lock.d", "owner.json");
  recordEffect(receipt, "fs:read-owner", onEffect);
  const owner = JSON.parse(await dependencies.readFile(ownerPath, "utf8"));
  if (
    owner.lockId !== ownerToken ||
    !Number.isInteger(owner.pid) ||
    owner.pid < 1 ||
    typeof owner.processStartUtc !== "string"
  ) {
    throw new HelpCategoryResponseBudgetError(
      "HEAVY_OWNER_IDENTITY_MISMATCH",
      "the live owner record does not match the admitted owner token.",
    );
  }
  return {
    tokenDigest: createHash("sha256").update(ownerToken, "utf8").digest("hex").slice(0, 8),
    pid: owner.pid,
    processStartUtc: owner.processStartUtc,
  };
}

function sameOwnerIdentity(left, right) {
  return (
    left.tokenDigest === right.tokenDigest && left.pid === right.pid && left.processStartUtc === right.processStartUtc
  );
}

async function invokeProcess(spec, dependencies, receipt, onEffect) {
  recordEffect(receipt, `spawn:${spec.id}`, onEffect);
  receipt.commands.push({
    id: spec.id,
    display: spec.display,
    ownerTokenInherited: Boolean(spec.env.CHASE_SETS_HEAVY_SLOT_ID),
  });
  return dependencies.runProcess(spec);
}

function launchProcess(spec, dependencies, receipt, onEffect) {
  recordEffect(receipt, `spawn:${spec.id}`, onEffect);
  receipt.commands.push({
    id: spec.id,
    display: spec.display,
    ownerTokenInherited: Boolean(spec.env.CHASE_SETS_HEAVY_SLOT_ID),
  });
  return dependencies.startProcess(spec);
}

async function waitForServer(baseUrl, server, dependencies, receipt, onEffect) {
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    if (server.exited) {
      throw new HelpCategoryResponseBudgetError("PUBLIC_WEB_START_FAILED", "public-web exited before readiness.");
    }
    try {
      recordEffect(receipt, `fetch:readiness:${attempt}`, onEffect);
      const response = await dependencies.fetch(baseUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status < 500) return;
    } catch {
      // The server is still starting. The next bounded probe remains under the
      // one owner acquired before the worktree was created.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new HelpCategoryResponseBudgetError("PUBLIC_WEB_READINESS_TIMEOUT", "public-web did not become ready.");
}

function smokeOutput(result, ownerToken) {
  return `${redact(result.stdout, ownerToken)}${result.stdout && result.stderr ? "\n" : ""}${redact(
    result.stderr,
    ownerToken,
  )}`;
}

function validateCandidateSmoke(result, output) {
  requireSuccess(result, "CANDIDATE_SMOKE_FAILED", "candidate complete route walk");
  if (!/Derived 43 members .*: 41 fetchable, 2 indeterminate, 5 strict healthy targets\./u.test(output)) {
    throw new HelpCategoryResponseBudgetError(
      "CANDIDATE_INVENTORY_MISMATCH",
      "candidate did not walk 41 of 43 members.",
    );
  }
  const selling = output.match(/help-category:selling \/help\/selling -> 200 \((\d+) bytes\)/u);
  if (!selling) {
    throw new HelpCategoryResponseBudgetError("CANDIDATE_SELLING_MISSING", "candidate omitted /help/selling.");
  }
  const bytes = Number.parseInt(selling[1], 10);
  if (bytes > SHIPPED_RESPONSE_BOUND_BYTES) {
    throw new HelpCategoryResponseBudgetError(
      "CANDIDATE_RESPONSE_TOO_LARGE",
      `candidate /help/selling was ${bytes} bytes.`,
    );
  }
  if (!/Passed 41 fetchable members in no-5xx mode/u.test(output)) {
    throw new HelpCategoryResponseBudgetError("CANDIDATE_WALK_INCOMPLETE", "candidate route walk was incomplete.");
  }
  return bytes;
}

function validateMutantSmoke(result, output) {
  if (result.code === 0) {
    throw new HelpCategoryResponseBudgetError(
      "MUTANT_UNEXPECTEDLY_GREEN",
      "full-body mutant passed the response bound.",
    );
  }
  const expectedFailure = "[response-too-large] help-category:selling (/help/selling) exceeded 122727 bytes.";
  if (!output.includes(expectedFailure)) {
    throw new HelpCategoryResponseBudgetError(
      "MUTANT_WRONG_FAILURE",
      "full-body mutant did not fail specifically through response-too-large.",
    );
  }
  if (forbiddenMutantFailureReasons.some((reason) => output.includes(`[${reason}]`))) {
    throw new HelpCategoryResponseBudgetError(
      "MUTANT_NON_DISCRIMINATING_FAILURE",
      "full-body mutant reached an additional failure classification.",
    );
  }
  return expectedFailure;
}

function formatTranscript(receipt, ownerToken) {
  const lines = [
    "CHASE_SETS_HELP_CATEGORY_RESPONSE_BUDGET_TRANSCRIPT_V1",
    `salvageHead=${receipt.salvageHead}`,
    `candidateCommit=${receipt.candidateCommit ?? "unresolved"}`,
    `candidateParent=${receipt.candidateParent ?? "unresolved"}`,
    `appliedPatchSha256=${receipt.appliedPatchSha256 ?? "unresolved"}`,
    `mutantPatchSha256=${receipt.mutantPatchSha256 ?? "unresolved"}`,
    `disposableWorktree=${receipt.disposableWorktree ?? "unresolved"}`,
    `resolvedClient=${receipt.resolvedClient ?? "unresolved"}`,
  ];
  for (const phase of ["candidate", "mutant"]) {
    const capture = receipt[phase];
    if (!capture) continue;
    lines.push(
      "",
      `[${phase}]`,
      `client=${capture.client}`,
      `owner=${ownerIdentityText(capture.owner)}`,
      `buildCommand=${capture.buildCommand}`,
      `serverOrigin=${capture.serverOrigin}`,
      `requestTime=${capture.requestTime}`,
      `smokeCommand=${capture.smokeCommand}`,
      `smokeExitCode=${capture.smokeExitCode}`,
      ...(capture.sellingBytes === undefined ? [] : [`sellingBytes=${capture.sellingBytes}`]),
      ...(capture.failureReason === undefined ? [] : [`failureReason=${capture.failureReason}`]),
      "smokeOutputBegin",
      capture.smokeOutput,
      "smokeOutputEnd",
    );
  }
  lines.push(
    "",
    `[cleanup]`,
    `serversTerminated=${receipt.cleanup.serversTerminated.join(",") || "none"}`,
    `worktreeRemoved=${receipt.cleanup.worktreeRemoved}`,
    `patchFilesRemoved=${receipt.cleanup.patchFilesRemoved}`,
    `cleanupErrors=${receipt.cleanup.errors.join(" | ") || "none"}`,
    "",
    "[effectLog]",
    ...receipt.effectLog,
  );
  return `${redact(lines.join("\n"), ownerToken)}\n`;
}

async function runAdmitted(options, dependencies, receipt) {
  const { onEffect } = options;
  const environment = options.environment ?? process.env;
  const implementationRoot = path.resolve(options.implementationRoot ?? process.cwd());
  const ownerToken = environment.CHASE_SETS_HEAVY_SLOT_ID;
  recordEffect(receipt, "client-resolution:implementation", onEffect);
  const implementationClient = dependencies.findHeavySlotClient(path.join(implementationRoot, "scripts", "lib"));
  if (!implementationClient) {
    throw new HelpCategoryResponseBudgetError(
      "HEAVY_CLIENT_RESOLUTION_FAILED",
      "the implementation worktree did not resolve an admitting client.",
    );
  }
  const containerRoot = path.dirname(path.dirname(implementationClient));
  const randomId = dependencies.randomId();
  const disposableWorktree = path.resolve(dependencies.createWorktreePath(containerRoot, randomId));
  const transcriptPath = path.join(
    dependencies.temporaryDirectory(),
    `chase-sets-6441-help-category-response-budget-${randomId}.log`,
  );
  const candidatePatchPath = path.join(
    dependencies.temporaryDirectory(),
    `chase-sets-6441-candidate-${randomId}.patch`,
  );
  const routePatchPath = path.join(dependencies.temporaryDirectory(), `chase-sets-6441-route-${randomId}.patch`);
  const childEnvironment = { ...environment, NO_COLOR: "1", FORCE_COLOR: "0" };
  const baseUrl = `http://localhost:${options.port}`;
  receipt.disposableWorktree = disposableWorktree;
  receipt.transcriptPath = transcriptPath;
  receipt.salvageHead = options.salvageHead;
  let worktreeCleanupRequired = false;
  const patchFiles = [];
  const servers = [];
  const terminatedServers = new Set();
  let primaryError;

  try {
    const initialOwner = await readOwnerIdentity(implementationClient, environment, dependencies, receipt, onEffect);
    recordEffect(receipt, "fs:assert-created-paths-absent", onEffect);
    const existingCreatedPaths = [];
    for (const candidate of [disposableWorktree, candidatePatchPath, routePatchPath, transcriptPath]) {
      if (await dependencies.pathExists(candidate)) existingCreatedPaths.push(candidate);
    }
    if (existingCreatedPaths.length > 0) {
      throw new HelpCategoryResponseBudgetError(
        "CREATED_PATH_COLLISION",
        `refusing to overwrite or remove pre-existing paths: ${existingCreatedPaths.join(", ")}`,
      );
    }
    recordEffect(receipt, "fs:read-container-ignore", onEffect);
    const containerIgnore = await dependencies.readFile(path.join(containerRoot, ".gitignore"), "utf8");
    const worktreeName = path.basename(disposableWorktree);
    if (
      !/^review-[A-Za-z0-9._-]{1,72}$/u.test(worktreeName) ||
      normalizedPath(disposableWorktree) === normalizedPath(implementationRoot)
    ) {
      throw new HelpCategoryResponseBudgetError(
        "DISPOSABLE_WORKTREE_PLACEMENT_INVALID",
        "the disposable worktree must use a safe review-* name outside the implementation worktree.",
      );
    }

    const candidateResult = requireSuccess(
      await invokeProcess(
        gitCommand(["rev-parse", "HEAD"], {
          id: "resolve-candidate-commit",
          cwd: implementationRoot,
          env: childEnvironment,
        }),
        dependencies,
        receipt,
        onEffect,
      ),
      "CANDIDATE_COMMIT_UNRESOLVED",
      "candidate commit resolution",
    );
    receipt.candidateCommit = candidateResult.stdout.trim();
    if (!/^[a-f0-9]{40}$/u.test(receipt.candidateCommit)) {
      throw new HelpCategoryResponseBudgetError("CANDIDATE_COMMIT_INVALID", "candidate commit was not a full SHA.");
    }
    const parentResult = requireSuccess(
      await invokeProcess(
        gitCommand(["rev-parse", `${receipt.candidateCommit}^`], {
          id: "resolve-candidate-parent",
          cwd: implementationRoot,
          env: childEnvironment,
        }),
        dependencies,
        receipt,
        onEffect,
      ),
      "CANDIDATE_PARENT_UNRESOLVED",
      "candidate parent resolution",
    );
    receipt.candidateParent = parentResult.stdout.trim();
    requireSuccess(
      await invokeProcess(
        gitCommand(["cat-file", "-e", `${options.salvageHead}^{commit}`], {
          id: "validate-salvage-head",
          cwd: implementationRoot,
          env: childEnvironment,
        }),
        dependencies,
        receipt,
        onEffect,
      ),
      "SALVAGE_HEAD_UNRESOLVED",
      "salvage head validation",
    );
    const sourceInventory = requireSuccess(
      await invokeProcess(
        gitCommand(
          ["diff", "--name-only", receipt.candidateParent, receipt.candidateCommit, "--", ...sourcePatchPaths],
          {
            id: "source-patch-inventory",
            cwd: implementationRoot,
            env: childEnvironment,
          },
        ),
        dependencies,
        receipt,
        onEffect,
      ),
      "SOURCE_PATCH_INVENTORY_FAILED",
      "source patch inventory",
    );
    assertExactLines(sourceInventory.stdout, sourcePatchPaths, "SOURCE_PATCH_INVENTORY_MISMATCH", "source patch");

    const candidatePatch = requireSuccess(
      await invokeProcess(
        gitCommand(
          [
            "diff",
            "--binary",
            "--no-ext-diff",
            receipt.candidateParent,
            receipt.candidateCommit,
            "--",
            ...sourcePatchPaths,
          ],
          { id: "create-candidate-patch", cwd: implementationRoot, env: childEnvironment },
        ),
        dependencies,
        receipt,
        onEffect,
      ),
      "CANDIDATE_PATCH_FAILED",
      "candidate patch creation",
    ).stdout;
    const routePatch = requireSuccess(
      await invokeProcess(
        gitCommand(
          ["diff", "--binary", "--no-ext-diff", receipt.candidateParent, receipt.candidateCommit, "--", routePath],
          { id: "create-mutant-patch", cwd: implementationRoot, env: childEnvironment },
        ),
        dependencies,
        receipt,
        onEffect,
      ),
      "MUTANT_PATCH_FAILED",
      "mutant patch creation",
    ).stdout;
    if (!candidatePatch || !routePatch) {
      throw new HelpCategoryResponseBudgetError(
        "SOURCE_PATCH_EMPTY",
        "candidate and route patches must both be non-empty.",
      );
    }
    receipt.appliedPatchSha256 = createHash("sha256").update(candidatePatch, "utf8").digest("hex");
    receipt.mutantPatchSha256 = createHash("sha256").update(routePatch, "utf8").digest("hex");
    patchFiles.push(candidatePatchPath);
    recordEffect(receipt, "fs:write-candidate-patch", onEffect);
    await dependencies.writeFile(candidatePatchPath, candidatePatch, { encoding: "utf8", flag: "wx" });
    patchFiles.push(routePatchPath);
    recordEffect(receipt, "fs:write-mutant-patch", onEffect);
    await dependencies.writeFile(routePatchPath, routePatch, { encoding: "utf8", flag: "wx" });

    worktreeCleanupRequired = true;
    requireSuccess(
      await invokeProcess(
        gitCommand(["worktree", "add", "--detach", disposableWorktree, options.salvageHead], {
          id: "create-disposable-worktree",
          cwd: implementationRoot,
          env: childEnvironment,
          capture: false,
        }),
        dependencies,
        receipt,
        onEffect,
      ),
      "WORKTREE_CREATE_FAILED",
      "disposable worktree creation",
    );

    const disposableClient = dependencies.findHeavySlotClient(path.join(disposableWorktree, "scripts", "lib"));
    recordEffect(receipt, `placement-check:${disposableClient ?? "null"}`, onEffect);
    if (!disposableClient || normalizedPath(disposableClient) !== normalizedPath(implementationClient)) {
      recordEffect(receipt, "diagnostic:heavy-client-resolution-mismatch", onEffect);
      throw new HelpCategoryResponseBudgetError(
        "HEAVY_CLIENT_RESOLUTION_MISMATCH",
        "the disposable worktree did not resolve the exact client that admitted the driver.",
      );
    }
    if (
      normalizedPath(path.dirname(disposableWorktree)) !== normalizedPath(containerRoot) ||
      !containerIgnore.split(/\r?\n/u).some((line) => line.trim() === "/review-*")
    ) {
      throw new HelpCategoryResponseBudgetError(
        "DISPOSABLE_WORKTREE_PLACEMENT_INVALID",
        "the admitted disposable worktree must be an ignored direct child of the container root.",
      );
    }
    receipt.resolvedClient = disposableClient;

    requireSuccess(
      await invokeProcess(
        pnpmCommand(
          ["run", "deps:install"],
          {
            id: "install-dependencies",
            cwd: disposableWorktree,
            env: childEnvironment,
          },
          dependencies,
        ),
        dependencies,
        receipt,
        onEffect,
      ),
      "DEPENDENCY_INSTALL_FAILED",
      "dependency installation",
    );
    requireSuccess(
      await invokeProcess(
        gitCommand(["-C", disposableWorktree, "apply", candidatePatchPath], {
          id: "apply-candidate-patch",
          cwd: implementationRoot,
          env: childEnvironment,
        }),
        dependencies,
        receipt,
        onEffect,
      ),
      "CANDIDATE_PATCH_APPLY_FAILED",
      "candidate patch application",
    );
    const candidateInventory = requireSuccess(
      await invokeProcess(
        gitCommand(["-C", disposableWorktree, "diff", "--name-only"], {
          id: "candidate-working-inventory",
          cwd: implementationRoot,
          env: childEnvironment,
        }),
        dependencies,
        receipt,
        onEffect,
      ),
      "CANDIDATE_WORKING_INVENTORY_FAILED",
      "candidate working inventory",
    );
    assertExactLines(
      candidateInventory.stdout,
      sourcePatchPaths,
      "CANDIDATE_WORKING_INVENTORY_MISMATCH",
      "candidate worktree",
    );

    const buildArgs = ["--filter", "@chase-sets/app-public-web", "run", "build"];
    const startArgs = ["--filter", "@chase-sets/app-public-web", "run", "start"];
    const smokeArgs = ["run", "smoke:public-web-routes", "--", "--base-url", baseUrl, "--mode", "no-5xx"];

    recordEffect(receipt, "client-resolution:candidate-build", onEffect);
    const candidateClient = dependencies.findHeavySlotClient(path.join(disposableWorktree, "scripts", "lib"));
    if (!candidateClient || normalizedPath(candidateClient) !== normalizedPath(implementationClient)) {
      throw new HelpCategoryResponseBudgetError(
        "HEAVY_CLIENT_RESOLUTION_MISMATCH",
        "the candidate build no longer resolved the admitting client.",
      );
    }
    const candidateOwner = await readOwnerIdentity(candidateClient, environment, dependencies, receipt, onEffect);
    if (!sameOwnerIdentity(initialOwner, candidateOwner)) {
      throw new HelpCategoryResponseBudgetError("HEAVY_OWNER_CHANGED", "owner changed before the candidate build.");
    }
    const candidateBuild = pnpmCommand(
      buildArgs,
      {
        id: "build-candidate",
        cwd: disposableWorktree,
        env: childEnvironment,
      },
      dependencies,
    );
    requireSuccess(
      await invokeProcess(candidateBuild, dependencies, receipt, onEffect),
      "CANDIDATE_BUILD_FAILED",
      "candidate build",
    );
    const candidateServer = launchProcess(
      pnpmCommand(
        startArgs,
        {
          id: "start-candidate",
          cwd: disposableWorktree,
          env: { ...childEnvironment, HOST: "localhost", PORT: String(options.port) },
        },
        dependencies,
      ),
      dependencies,
      receipt,
      onEffect,
    );
    servers.push(candidateServer);
    await waitForServer(baseUrl, candidateServer, dependencies, receipt, onEffect);
    const candidateRequestTime = dependencies.now();
    const candidateSmokeSpec = pnpmCommand(
      smokeArgs,
      {
        id: "smoke-candidate",
        cwd: disposableWorktree,
        env: childEnvironment,
        capture: true,
      },
      dependencies,
    );
    const candidateSmoke = await invokeProcess(candidateSmokeSpec, dependencies, receipt, onEffect);
    const candidateOutput = smokeOutput(candidateSmoke, ownerToken);
    const candidateSellingBytes = validateCandidateSmoke(candidateSmoke, candidateOutput);
    recordEffect(receipt, "terminate:start-candidate", onEffect);
    await dependencies.terminateProcess(candidateServer);
    terminatedServers.add(candidateServer);

    receipt.candidate = {
      client: candidateClient,
      owner: candidateOwner,
      buildCommand: candidateBuild.display,
      serverOrigin: baseUrl,
      requestTime: candidateRequestTime,
      smokeCommand: candidateSmokeSpec.display,
      smokeExitCode: candidateSmoke.code,
      sellingBytes: candidateSellingBytes,
      smokeOutput: candidateOutput,
    };

    requireSuccess(
      await invokeProcess(
        gitCommand(["-C", disposableWorktree, "apply", "--reverse", routePatchPath], {
          id: "apply-full-body-mutant",
          cwd: implementationRoot,
          env: childEnvironment,
        }),
        dependencies,
        receipt,
        onEffect,
      ),
      "MUTANT_PATCH_APPLY_FAILED",
      "full-body mutant application",
    );
    const mutantInventory = requireSuccess(
      await invokeProcess(
        gitCommand(["-C", disposableWorktree, "diff", "--name-only"], {
          id: "mutant-working-inventory",
          cwd: implementationRoot,
          env: childEnvironment,
        }),
        dependencies,
        receipt,
        onEffect,
      ),
      "MUTANT_WORKING_INVENTORY_FAILED",
      "mutant working inventory",
    );
    assertExactLines(mutantInventory.stdout, [cardPath], "MUTANT_WORKING_INVENTORY_MISMATCH", "mutant worktree");

    recordEffect(receipt, "client-resolution:mutant-build", onEffect);
    const mutantClient = dependencies.findHeavySlotClient(path.join(disposableWorktree, "scripts", "lib"));
    if (!mutantClient || normalizedPath(mutantClient) !== normalizedPath(implementationClient)) {
      throw new HelpCategoryResponseBudgetError(
        "HEAVY_CLIENT_RESOLUTION_MISMATCH",
        "the mutant build no longer resolved the admitting client.",
      );
    }
    const mutantOwner = await readOwnerIdentity(mutantClient, environment, dependencies, receipt, onEffect);
    if (!sameOwnerIdentity(candidateOwner, mutantOwner)) {
      throw new HelpCategoryResponseBudgetError("HEAVY_OWNER_CHANGED", "owner changed before the mutant build.");
    }
    const mutantBuild = pnpmCommand(
      buildArgs,
      {
        id: "build-mutant",
        cwd: disposableWorktree,
        env: childEnvironment,
      },
      dependencies,
    );
    requireSuccess(
      await invokeProcess(mutantBuild, dependencies, receipt, onEffect),
      "MUTANT_BUILD_FAILED",
      "mutant build",
    );
    const mutantServer = launchProcess(
      pnpmCommand(
        startArgs,
        {
          id: "start-mutant",
          cwd: disposableWorktree,
          env: { ...childEnvironment, HOST: "localhost", PORT: String(options.port) },
        },
        dependencies,
      ),
      dependencies,
      receipt,
      onEffect,
    );
    servers.push(mutantServer);
    await waitForServer(baseUrl, mutantServer, dependencies, receipt, onEffect);
    const mutantRequestTime = dependencies.now();
    const mutantSmokeSpec = pnpmCommand(
      smokeArgs,
      {
        id: "smoke-mutant",
        cwd: disposableWorktree,
        env: childEnvironment,
        capture: true,
      },
      dependencies,
    );
    const mutantSmoke = await invokeProcess(mutantSmokeSpec, dependencies, receipt, onEffect);
    const mutantOutput = smokeOutput(mutantSmoke, ownerToken);
    const mutantFailure = validateMutantSmoke(mutantSmoke, mutantOutput);
    recordEffect(receipt, "terminate:start-mutant", onEffect);
    await dependencies.terminateProcess(mutantServer);
    terminatedServers.add(mutantServer);

    receipt.mutant = {
      client: mutantClient,
      owner: mutantOwner,
      buildCommand: mutantBuild.display,
      serverOrigin: baseUrl,
      requestTime: mutantRequestTime,
      smokeCommand: mutantSmokeSpec.display,
      smokeExitCode: mutantSmoke.code,
      failureReason: mutantFailure,
      smokeOutput: mutantOutput,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    for (const server of servers) {
      if (terminatedServers.has(server)) continue;
      try {
        recordEffect(receipt, `terminate:${server.id}`, onEffect);
        await dependencies.terminateProcess(server);
        terminatedServers.add(server);
      } catch (error) {
        receipt.cleanup.errors.push(`terminate ${server.id}: ${redact(error.message, ownerToken)}`);
      }
    }
    receipt.cleanup.serversTerminated = [...terminatedServers].map((server) => server.id);

    if (worktreeCleanupRequired) {
      try {
        const removal = await invokeProcess(
          gitCommand(["worktree", "remove", "--force", disposableWorktree], {
            id: "remove-disposable-worktree",
            cwd: implementationRoot,
            env: childEnvironment,
          }),
          dependencies,
          receipt,
          onEffect,
        );
        if (removal.code !== 0) {
          receipt.cleanup.errors.push(`git worktree remove exited ${removal.code ?? "without a code"}`);
        }
      } catch (error) {
        receipt.cleanup.errors.push(`git worktree remove: ${redact(error.message, ownerToken)}`);
      }
      try {
        recordEffect(receipt, "fs:remove-disposable-worktree", onEffect);
        await dependencies.removePath(disposableWorktree, { recursive: true, force: true });
        receipt.cleanup.worktreeRemoved = true;
      } catch (error) {
        receipt.cleanup.errors.push(`remove worktree path: ${redact(error.message, ownerToken)}`);
      }
    }

    for (const patchFile of patchFiles) {
      try {
        recordEffect(receipt, `fs:remove-patch:${path.basename(patchFile)}`, onEffect);
        await dependencies.removePath(patchFile, { force: true });
        receipt.cleanup.patchFilesRemoved += 1;
      } catch (error) {
        receipt.cleanup.errors.push(`remove patch: ${redact(error.message, ownerToken)}`);
      }
    }

    try {
      recordEffect(receipt, "fs:write-transcript", onEffect);
      const transcript = formatTranscript(receipt, ownerToken);
      receipt.transcriptSha256 = createHash("sha256").update(transcript, "utf8").digest("hex");
      await dependencies.writeFile(transcriptPath, transcript, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      receipt.cleanup.errors.push(`write transcript: ${redact(error.message, ownerToken)}`);
    }
  }

  if (primaryError) {
    primaryError.receipt = receipt;
    primaryError.effectLog = receipt.effectLog;
    throw primaryError;
  }
  if (receipt.cleanup.errors.length > 0) {
    const error = new HelpCategoryResponseBudgetError(
      "CLEANUP_FAILED",
      `cleanup was incomplete: ${receipt.cleanup.errors.join(" | ")}`,
    );
    error.receipt = receipt;
    error.effectLog = receipt.effectLog;
    throw error;
  }
  return receipt;
}

export async function runHelpCategoryResponseBudget(options, injectedDependencies = {}) {
  const dependencies = { ...createDefaultDependencies(), ...injectedDependencies };
  const receipt = {
    effectLog: [],
    commands: [],
    cleanup: { serversTerminated: [], worktreeRemoved: false, patchFilesRemoved: 0, errors: [] },
  };
  recordEffect(receipt, "admission:build", options.onEffect);
  const admitted = dependencies.acquireHeavySlot("build", {
    startDirectory: path.join(options.implementationRoot ?? process.cwd(), "scripts", "lib"),
  });
  if (!admitted) {
    const error = new HelpCategoryResponseBudgetError(
      "HEAVY_ADMISSION_REFUSED",
      "no canonical heavy-slot client admitted the driver; no command body was executed.",
    );
    error.effectLog = receipt.effectLog;
    throw error;
  }
  return runAdmitted(options, dependencies, receipt);
}

export function parseHelpCategoryResponseBudgetArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!["--salvage-head", "--port"].includes(option) || !value) {
      throw new HelpCategoryResponseBudgetError("ARGUMENT_INVALID", `unexpected or incomplete argument '${option}'.`);
    }
    if (values.has(option)) {
      throw new HelpCategoryResponseBudgetError("ARGUMENT_DUPLICATE", `${option} may be provided only once.`);
    }
    values.set(option, value);
  }
  if (values.get("--salvage-head") !== EXPECTED_SALVAGE_HEAD) {
    throw new HelpCategoryResponseBudgetError(
      "SALVAGE_HEAD_INVALID",
      `--salvage-head must be the immutable ${EXPECTED_SALVAGE_HEAD} head.`,
    );
  }
  const port = Number.parseInt(values.get("--port") ?? "", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== values.get("--port")) {
    throw new HelpCategoryResponseBudgetError("PORT_INVALID", "--port must be an integer from 1 through 65535.");
  }
  return { salvageHead: EXPECTED_SALVAGE_HEAD, port };
}

async function main() {
  const receipt = await runHelpCategoryResponseBudget({
    ...parseHelpCategoryResponseBudgetArgs(process.argv.slice(2)),
    implementationRoot: process.cwd(),
  });
  console.log(
    `[help-category-response-budget] candidate=${receipt.candidateCommit} exit=${receipt.candidate.smokeExitCode}`,
  );
  console.log(
    `[help-category-response-budget] mutant=full-body-category-serialization exit=${receipt.mutant.smokeExitCode}`,
  );
  console.log(`[help-category-response-budget] transcript=${receipt.transcriptPath}`);
  console.log(`[help-category-response-budget] transcriptSha256=${receipt.transcriptSha256}`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error.message);
    if (error.receipt?.transcriptPath) {
      console.error(`[help-category-response-budget] transcript=${error.receipt.transcriptPath}`);
    }
    process.exitCode = error.code === "HEAVY_ADMISSION_REFUSED" ? 73 : 1;
  });
}
