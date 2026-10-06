import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { cpus, totalmem, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { acquireHeavySlot } from "../../../scripts/lib/heavy-slot.mjs";
import { buildPackageManagerInvocation, terminateProcessTree } from "../../../scripts/lib/process.mjs";
import { classifyGuardScreen, guardReserveMs } from "./b3-guard-screen-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, "..");
const root = resolve(apiRoot, "../..");
const sourceBase = "f3fffacb10437c1528cfc0b3702168391d0e0445";
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const saveNew = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

async function child(inputPath, resultPath) {
  assert.equal(acquireHeavySlot("repository-gate"), true, "canonical nested admission is unavailable");
  const input = json(inputPath);
  const { checkBootstrapDbEnrollment, derivePlatformApiDbTestCensus } =
    await import("./check-bootstrap-db-enrollment.mjs");
  const frozen = json(resolve(here, "b3-capture-manifest.json"));
  const bootstrap = Object.entries(frozen).filter(([, value]) => !value.censusCaseNames);
  assert.deepEqual(Object.keys(input.manifest).sort(), bootstrap.map(([file]) => file).sort());
  const bootCeilings = { "test:db:1": 25, "test:db:2": 20, "test:db:3": 15 };
  for (const [file, entry] of bootstrap) {
    assert.equal(input.manifest[file].executionUnit, entry.executionUnit);
    assert.deepEqual(
      input.manifest[file].cases.map(({ name, identity }) => ({ name, identity })),
      entry.cases,
    );
    assert.equal(sha(resolve(apiRoot, "__tests__", file)), entry.sourceSha256);
  }
  for (const [key, value] of Object.entries({
    maxWorkersPerExecutionUnit: 3,
    executionUnitCeilingMs: 420000,
    aggregateCeilingMs: 1080000,
    maximumCaseReferenceDurationMs: 600000,
    maximumScheduledFileCount: 12,
    maximumEnumeratedUnitCount: 4,
  }))
    assert.equal(input.model[key], value, key);
  assert.equal(input.model.referenceRunId, input.owner.runId);
  assert.equal(input.model.referenceJobId, input.owner.jobId);
  assert.equal(input.model.referenceHeadSha, input.owner.head);
  assert.equal(input.model.referenceEvent, "push");
  assert.equal(input.census.referenceRunId, input.owner.runId);
  assert.equal(input.census.referenceJobId, input.owner.jobId);
  const { captureCensusFiles } = await import("./b3-capture-census.mjs");
  assert.deepEqual(
    input.census.entries,
    Object.fromEntries(captureCensusFiles.map((file) => ["__tests__/" + file, "test:db:2"])),
  );
  const result = checkBootstrapDbEnrollment({
    platformApiRoot: apiRoot,
    manifest: input.manifest,
    scheduleModel: input.model,
    nonBootstrapCensus: input.census,
    executionUnitBootBearingCaseCeilings: bootCeilings,
  });
  const census = derivePlatformApiDbTestCensus({ platformApiRoot: apiRoot });
  saveNew(resultPath, {
    result,
    census,
    inputSha256: sha(inputPath),
    heap: process.memoryUsage(),
    peakRssKiB: process.resourceUsage().maxRSS,
    finishedAt: new Date().toISOString(),
  });
}

async function run(inputPath, outputDirectory, dispatchPath) {
  // Admission refusal (73) happens before any observation or one-shot reservation.
  assert.equal(acquireHeavySlot("repository-gate"), true, "canonical heavy verifier is unavailable");
  const input = json(inputPath),
    dispatch = json(dispatchPath);
  assert.equal(dispatch.schema, "8843-guard-screen-dispatch/v1");
  assert.equal(dispatch.role, "implementation/verifier");
  for (const key of ["lane", "canonicalDispatch", "sourceAdmission", "nativeValidationReceipt"])
    assert.equal(typeof dispatch[key], "string", key);
  assert.equal(dispatch.inputSha256, sha(inputPath));
  assert.equal(dispatch.head, input.owner.head);
  assert.equal(input.owner.runAttempt, 1);
  for (const key of ["runId", "jobId", "artifactId"])
    assert(Number.isSafeInteger(input.owner[key]) && input.owner[key] > 0, key);
  assert.match(input.owner.artifactDigest, /^sha256:[a-f0-9]{64}$/);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  assert.equal(git("rev-parse", "HEAD"), input.owner.head);
  assert.equal(git("status", "--porcelain"), "");
  const parents = git("cat-file", "-p", "HEAD")
    .split("\n\n", 1)[0]
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice(7));
  assert.deepEqual(parents, [sourceBase]);
  assert.match(process.version, /^v24\./);
  const pnpm = buildPackageManagerInvocation(["--version"]);
  const pnpmVersion = execFileSync(pnpm.command, pnpm.args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  assert.equal(pnpmVersion, "11.0.9");
  mkdirSync(outputDirectory, { recursive: true });
  const reservation = resolve(outputDirectory, "screen-start.json");
  saveNew(reservation, { owner: input.owner, dispatch, inputSha256: sha(inputPath), utc: new Date().toISOString() });
  const rawPath = resolve(outputDirectory, "guard-screen-raw.json");
  const stdout = openSync(resolve(outputDirectory, "guard-screen.stdout.log"), "wx");
  const stderr = openSync(resolve(outputDirectory, "guard-screen.stderr.log"), "wx");
  const startedAt = new Date().toISOString(),
    started = performance.now();
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", inputPath, rawPath], {
    cwd: root,
    stdio: ["ignore", stdout, stderr],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let timedOut = false,
    interrupted = null;
  const kill = () => terminateProcessTree(worker, "SIGKILL", { processGroup: process.platform !== "win32" });
  const onTerm = () => {
    interrupted = "SIGTERM";
    kill();
  };
  const onInt = () => {
    interrupted = "SIGINT";
    kill();
  };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  const timer = setTimeout(
    () => {
      timedOut = true;
      kill();
    },
    Math.max(0, guardReserveMs - (performance.now() - started)),
  );
  const terminal = await new Promise((done) => {
    worker.once("error", (error) => done({ exitCode: null, error: error.message }));
    worker.once("close", (exitCode, signal) => done({ exitCode, signal }));
  });
  const elapsedMs = Math.ceil(performance.now() - started),
    finishedAt = new Date().toISOString();
  clearTimeout(timer);
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  closeSync(stdout);
  closeSync(stderr);
  let raw = null;
  try {
    raw = json(rawPath);
  } catch {
    /* Missing/partial output is an explicit refusal below. */
  }
  const complete =
    !timedOut &&
    !interrupted &&
    raw?.inputSha256 === sha(inputPath) &&
    Number.isFinite(raw?.peakRssKiB) &&
    raw.peakRssKiB > 0 &&
    Number.isFinite(raw?.heap?.heapUsed) &&
    Number.isFinite(Date.parse(raw?.finishedAt));
  const policy = classifyGuardScreen({ ...raw, complete, elapsedMs, exitCode: terminal.exitCode });
  saveNew(resolve(outputDirectory, "guard-screen.json"), {
    ...policy,
    raw,
    terminal,
    timedOut,
    interrupted,
    elapsedMs,
    startedAt,
    finishedAt,
    owner: input.owner,
    dispatch,
    dispatchSha256: sha(dispatchPath),
    inputSha256: sha(inputPath),
    sourceBase,
    head: input.owner.head,
    sourceHashes: Object.fromEntries(
      [
        "b3-guard-screen.mjs",
        "b3-guard-screen-policy.mjs",
        "b3-capture-census.mjs",
        "b3-capture-manifest.json",
        "check-bootstrap-db-enrollment.mjs",
      ].map((name) => [name, sha(resolve(here, name))]),
    ),
    environment: {
      node: process.version,
      pnpm: pnpmVersion,
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpuModel: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
  });
  process.exitCode = policy.classification === "REFUSAL" ? 1 : 0;
}

try {
  const args = process.argv.slice(2);
  if (args[0] === "--child" && args.length === 3) await child(resolve(args[1]), resolve(args[2]));
  else if (args.length === 3) await run(...args.map((arg) => resolve(arg)));
  else throw new Error("usage: b3-guard-screen.mjs reference-inputs.json output-directory dispatch-binding.json");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
