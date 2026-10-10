import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { removalRefusal } from "./protocol.mjs";

const helper =
  "/usr/local/lib/chase-sets-provider-window-input/scripts/provider-object-disposition/browser-boundary/ownership-stimulus.py";
const env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
const retired = "provider-boundary-owner-stimulus:retired\n";
const errnos = ["ENOENT", "ESRCH", "EACCES", "EPERM", "EINVAL", "EIO", "other"];
const retirementReasons = new Set([
  "wait-timeout",
  "member-live",
  "member-parse",
  "foreign-file",
  "output",
  ...["signal", "wait", "member-read"].flatMap((step) => errnos.map((name) => `${step}-${name}`)),
]);
const treeStates = ["init-pre-exec", "child-absent", "child-pre-exec", "final", "incomplete"];
const refusalStages = [
  "remove-live-owner",
  "remove-orphan-owner",
  "remove-ambiguous-owner",
  "remove-ownership-census",
  "remove-target-symlink",
  "remove-target-path",
  "remove-profile-symlink",
  "input-not-symlink",
  "input-path",
];

export const DIAGNOSTIC_ITERATIONS = 20;
export const DIAGNOSTIC_OUT = "artifacts/browser-boundary-diagnostics/summary.json";
const diagnosticSelectors = new Map([
  ["13c-alone", { mode: "alone", count: 0 }],
  ["13c-concurrent-live", { mode: "concurrent-live", count: 1 }],
]);

const spawnHelper = (args) =>
  spawn("/usr/bin/sudo", ["-n", "/usr/bin/python3", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });

// Closed helper stderr: an optional main-stage refusal, then an optional
// retirement reason. Anything else is unrecognized and never echoed.
export function stimulusRefusal(stderr) {
  if (stderr.length === 0) return null;
  const match =
    /^(?:provider-boundary-owner-stimulus-refused:(arguments|construct|lifetime)\n)?(?:provider-boundary-owner-stimulus-refused:retirement:([a-z]+(?:-[a-zA-Z]+)*)\n)?$/.exec(
      stderr.toString("latin1"),
    );
  if (!match || (!match[1] && !match[2]) || (match[2] && !retirementReasons.has(match[2]))) return "unrecognized";
  return { stage: match[1] ?? null, retirement: match[2] ?? null };
}

// The orphan helper's generated-tree samples at readiness and at the refusal
// boundary. "unchanged" is not foreign attribution; see ownership-stimulus.py.
export function stimulusObservation(tail) {
  const match =
    /^provider-boundary-owner-stimulus:observed:ready=([a-z-]+);boundary=([a-z-]+);generated=(changed|unchanged|unproven)\n/.exec(
      tail.toString("latin1"),
    );
  if (!match || !treeStates.includes(match[1]) || !treeStates.includes(match[2])) return null;
  return { line: match[0], ready: match[1], boundary: match[2], generated: match[3] };
}

export function refusalStage(error) {
  return refusalStages.find((stage) => removalRefusal(error, stage)) ?? "unknown";
}

export function diagnosticSelection(argv) {
  if (argv.length === 0) return null;
  const [flag, selector, outFlag, out, ...rest] = argv;
  if (
    flag !== "--diagnostic" ||
    !diagnosticSelectors.has(selector) ||
    outFlag !== "--out" ||
    out !== DIAGNOSTIC_OUT ||
    rest.length
  )
    throw new Error("diagnostic-selector-refused");
  return { selector, ...diagnosticSelectors.get(selector), iterations: DIAGNOSTIC_ITERATIONS, out };
}

export function diagnosticProvenance(source) {
  const exact = (value, pattern) => (typeof value === "string" && pattern.test(value) ? value : null);
  return {
    head: exact(source.BOUNDARY_HEAD_SHA, /^[a-f0-9]{40}$/),
    runId: exact(source.GITHUB_RUN_ID, /^[1-9][0-9]{0,19}$/),
    runAttempt: exact(source.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]{0,4}$/),
    job: exact(source.GITHUB_JOB, /^[a-z][a-z0-9-]{0,63}$/),
  };
}

// A nongoverning subset: every claimed iteration is retained, a missing one is
// reported as not run, and all-green means no reproduction, never attribution.
export function diagnosticReport(selection, results, provenance) {
  const failed = results.filter(({ result }) => result === "fail").length;
  const passed = results.filter(({ result }) => result === "pass").length;
  const notRun = selection.iterations - results.length;
  const firstFailure = results.find(({ result }) => result === "fail") ?? null;
  const outcome = failed ? "reproduced" : notRun ? "incomplete" : "no reproduction";
  return {
    summary: {
      schema: "browser-boundary-diagnostics/v1",
      governing: false,
      proof: "NOT PROVEN",
      selector: selection.selector,
      ...provenance,
      iterations: selection.iterations,
      complete: notRun === 0,
      passed,
      failed,
      notRun,
      outcome,
      firstFailure: firstFailure && { iteration: firstFailure.iteration, control: firstFailure.firstFailure },
      results,
    },
    marker: `installed-boundary diagnostic ${selection.selector}: SUBSET; iterations=${selection.iterations} passed=${passed} failed=${failed} not-run=${notRun}; ${outcome}; NOT PROVEN; not the installed-boundary full step`,
    exitCode: failed === 0 && notRun === 0 ? 0 : 1,
  };
}

export async function withOwnershipStimulus(
  mode,
  test,
  owner,
  { spawnStimulus = spawnHelper, onPhase = () => {}, record = () => {} } = {},
) {
  assert.ok(["orphan", "foreign", "cap", "reuse"].includes(mode));
  if (mode === "reuse")
    assert.ok(
      Number.isSafeInteger(owner?.pid) && owner.pid > 1 && Number.isSafeInteger(owner?.start) && owner.start > 0,
    );
  const args =
    mode === "reuse"
      ? [helper.replace("ownership-stimulus.py", "pid-reuse.py"), String(owner.pid), String(owner.start)]
      : [helper, mode];
  const child = spawnStimulus(args);
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let resolveReady;
  let rejectReady;
  let overflow = false;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.on("data", (chunk) => {
    if (stdout.length + chunk.length > 4096) {
      overflow = true;
      child.stdin.end();
      rejectReady(new Error("owner-stimulus-overflow"));
      return;
    }
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.includes(10)) {
      try {
        resolveReady(JSON.parse(stdout.subarray(0, stdout.indexOf(10))));
      } catch {
        rejectReady(new Error("owner-stimulus-invalid"));
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length + chunk.length > 4096) {
      overflow = true;
      child.stdin.end();
    } else stderr = Buffer.concat([stderr, chunk]);
  });
  const ended = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      rejectReady(error);
      reject(error);
    });
    child.once("close", (code, signal) => {
      rejectReady(new Error("owner-stimulus-ended"));
      resolve({ code, signal });
    });
  });
  let primary;
  let constructed = false;
  // A callback failure keeps the callback's own phase; only a callback that
  // returned can be followed by a retirement-phase failure.
  let phase = "construction";
  onPhase(phase);
  const deadline = setTimeout(() => {
    child.stdin.end();
    rejectReady(new Error("owner-stimulus-deadline"));
  }, 15000);
  try {
    const result = await ready;
    assert.equal(typeof result.constructed, "boolean");
    if (!result.constructed) {
      assert.ok(["cap", "reuse"].includes(mode));
      if (mode === "cap") {
        assert.deepEqual(Object.keys(result).sort(), [
          "children",
          "constructed",
          "fileLimit",
          "processLimit",
          "reason",
        ]);
        assert.ok(["EAGAIN", "ENOMEM", "EMFILE", "construction"].includes(result.reason));
        assert.ok(
          [result.children, result.fileLimit, result.processLimit].every(
            (value) => Number.isSafeInteger(value) && value >= -1,
          ),
        );
      } else {
        assert.deepEqual(Object.keys(result).sort(), ["attempts", "constructed", "reason"]);
        assert.ok(["EROFS", "EACCES", "EPERM", "ENOENT", "attempts-exhausted"].includes(result.reason));
        assert.ok(Number.isSafeInteger(result.attempts) && result.attempts > 0 && result.attempts <= 8);
      }
      console.log(
        `installed-boundary control ${mode === "cap" ? "13g native cap" : "11a native reuse"}: NOT CONSTRUCTED; ${JSON.stringify(result)}`,
      );
    } else {
      constructed = true;
      if (mode === "reuse") {
        assert.deepEqual(Object.keys(result).sort(), ["attempts", "constructed", "pid", "start"]);
        assert.equal(result.pid, owner.pid);
        assert.ok(Number.isSafeInteger(result.start) && result.start > 0 && result.start !== owner.start);
        assert.ok(Number.isSafeInteger(result.attempts) && result.attempts > 0 && result.attempts <= 8);
      } else if (mode === "cap") {
        assert.deepEqual(Object.keys(result).sort(), [
          "children",
          "constructed",
          "fileLimit",
          "maxShardPidfds",
          "mode",
          "pid",
          "processCount",
          "processLimit",
          "shards",
          "start",
        ]);
        assert.equal(result.mode, "cap");
        assert.equal(result.children, 4097);
        assert.equal(result.shards, 17);
        assert.equal(result.maxShardPidfds, 256);
        assert.ok(Number.isSafeInteger(result.processCount) && result.processCount >= 4097);
        assert.ok([result.fileLimit, result.processLimit].every((value) => Number.isSafeInteger(value) && value > 0));
        assert.ok([result.pid, result.start].every((value) => Number.isSafeInteger(value) && value > 0));
        console.log(`installed-boundary control 13g bounded-FD construction:${JSON.stringify(result)}`);
      } else {
        assert.deepEqual(Object.keys(result).sort(), ["children", "constructed", "mode"]);
        assert.equal(result.mode, mode);
        assert.ok(Number.isSafeInteger(result.children) && result.children > 0 && result.children <= 4097);
      }
      phase = "callback";
      await test(result);
    }
    phase = "retirement";
    onPhase(phase);
  } catch (error) {
    primary = error;
  } finally {
    child.stdin.end();
    const status = await ended;
    clearTimeout(deadline);
    const tail = stdout.subarray(stdout.indexOf(10) + 1);
    const observation = mode === "orphan" && constructed && !overflow ? stimulusObservation(tail) : null;
    const exact =
      status.code === 0 &&
      status.signal === null &&
      !overflow &&
      stderr.length === 0 &&
      (mode !== "orphan" || observation !== null) &&
      tail.equals(
        Buffer.from(
          mode === "reuse"
            ? constructed
              ? "provider-boundary-pid-reuse:survived-retired\n"
              : ""
            : `${observation?.line ?? ""}${retired}`,
        ),
      );
    const entry = {
      mode,
      constructed,
      expectedStatus: 0,
      status: status.code,
      signal: status.signal,
      exactRetirement: exact,
      firstFailurePhase: primary ? phase : exact ? null : "retirement",
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
      refusal: overflow ? "unrecognized" : stimulusRefusal(stderr),
      generatedTree: observation && {
        ready: observation.ready,
        boundary: observation.boundary,
        generated: observation.generated,
      },
      redacted: true,
      truncated: overflow,
    };
    record(entry);
    console.log(`installed-boundary ownership-stimulus:${JSON.stringify(entry)}`);
    if (!exact) primary ??= new Error("owner-stimulus-retirement");
  }
  if (primary) throw primary;
  return constructed;
}
