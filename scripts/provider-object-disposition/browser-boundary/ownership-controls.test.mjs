import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIAGNOSTIC_ITERATIONS,
  DIAGNOSTIC_OUT,
  diagnosticProvenance,
  diagnosticReport,
  diagnosticSelection,
  refusalStage,
  stimulusObservation,
  stimulusRefusal,
  withOwnershipStimulus,
} from "./ownership-controls.mjs";

const construction = '{"constructed": true, "children": 1, "mode": "orphan"}\n';
const observed = "provider-boundary-owner-stimulus:observed:ready=init-pre-exec;boundary=final;generated=changed\n";
const retired = "provider-boundary-owner-stimulus:retired\n";
const esrch = "provider-boundary-owner-stimulus-refused:retirement:member-read-ESRCH\n";

// A synthetic helper: it prints construction, waits for EOF (unless
// construction failed), then emits the given retirement bytes. It never
// touches /proc or sudo.
const fakeHelper =
  ({ ready = construction, stdout = observed + retired, stderr = "", code = 0 } = {}) =>
  () =>
    spawn(
      process.execPath,
      [
        "-e",
        `const retire = () => {
  process.stdout.write(${JSON.stringify(stdout)});
  process.stderr.write(${JSON.stringify(stderr)});
  process.exitCode = ${code};
};
process.stdout.write(${JSON.stringify(ready)});
if (${JSON.stringify(ready)}) {
  process.stdin.resume();
  process.stdin.on("end", retire);
} else retire();`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

async function runCase(mode, helper, callback = async () => {}) {
  const labels = [];
  const entries = [];
  let label = "unset";
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const outcome = await withOwnershipStimulus(
    mode,
    async (result) => {
      label = "13c-alone-page-close";
      await callback(result);
    },
    undefined,
    {
      spawnStimulus: helper,
      onPhase: (phase) => {
        label = `13c-alone-stimulus-${phase}`;
        labels.push(phase);
      },
      record: (entry) => entries.push(entry),
    },
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const printed = logs.mock.calls.map((call) => call.join(" ")).join("\n");
  logs.mockRestore();
  return { ...outcome, label, labels, entry: entries[0], entries, printed };
}

afterEach(() => vi.restoreAllMocks());

describe("13c orphan stimulus wrapper phases (AC3)", () => {
  it("accepts the exact orphan observation and retirement", async () => {
    const run = await runCase("orphan", fakeHelper());
    expect(run.value).toBe(true);
    expect(run.labels).toEqual(["construction", "retirement"]);
    expect(run.entry).toMatchObject({
      exactRetirement: true,
      firstFailurePhase: null,
      refusal: null,
      generatedTree: { ready: "init-pre-exec", boundary: "final", generated: "changed" },
      stdoutBytes: Buffer.byteLength(construction + observed + retired),
      stderrBytes: 0,
    });
  });

  it("page-close PASS followed by a retirement failure reports retirement, never page-close", async () => {
    const run = await runCase("orphan", fakeHelper({ stdout: observed, stderr: esrch, code: 1 }));
    expect(run.error.message).toBe("owner-stimulus-retirement");
    expect(run.label).toBe("13c-alone-stimulus-retirement");
    expect(run.entry).toMatchObject({
      status: 1,
      exactRetirement: false,
      firstFailurePhase: "retirement",
      refusal: { stage: null, retirement: "member-read-ESRCH" },
      stdoutBytes: Buffer.byteLength(construction + observed),
      stderrBytes: Buffer.byteLength(esrch),
    });
  });

  it("a page-close exception keeps its label and first error even when retirement also fails", async () => {
    const failure = new Error("synthetic-page-close");
    const run = await runCase("orphan", fakeHelper({ stdout: observed, stderr: esrch, code: 1 }), async () => {
      throw failure;
    });
    expect(run.error).toBe(failure);
    expect(run.label).toBe("13c-alone-page-close");
    expect(run.labels).toEqual(["construction"]);
    expect(run.entry).toMatchObject({ firstFailurePhase: "callback", exactRetirement: false });
  });

  it("construction failure names construction and never runs the callback", async () => {
    const callback = vi.fn();
    const run = await runCase(
      "orphan",
      fakeHelper({
        ready: "",
        stderr: "provider-boundary-owner-stimulus-refused:construct\n",
        stdout: retired,
        code: 1,
      }),
      callback,
    );
    expect(callback).not.toHaveBeenCalled();
    // The helper's own retirement line is not a construction record.
    expect(run.error.message).toBe("owner-stimulus-invalid");
    expect(run.label).toBe("13c-alone-stimulus-construction");
    expect(run.entry).toMatchObject({
      constructed: false,
      firstFailurePhase: "construction",
      refusal: { stage: "construct", retirement: null },
    });
  });

  it.each([
    ["a missing observation line", retired],
    ["an unknown observation state", observed.replace("ready=init-pre-exec", "ready=PRIVATE") + retired],
    ["an observation after retirement", retired + observed],
    ["trailing private bytes", observed + retired + "PRIVATE\n"],
  ])("%s with status 0 never passes retirement", async (_, stdout) => {
    const run = await runCase("orphan", fakeHelper({ stdout }));
    expect(run.error.message).toBe("owner-stimulus-retirement");
    expect(run.entry.exactRetirement).toBe(false);
    expect(run.printed).not.toContain("PRIVATE");
  });

  it("private stderr markers and overflow are reported as unrecognized and never echoed", async () => {
    const marked = await runCase(
      "orphan",
      fakeHelper({ stderr: "provider-boundary-owner-stimulus-refused:retirement:SYNTHETIC_PRIVATE\n", code: 1 }),
    );
    expect(marked.entry.refusal).toBe("unrecognized");
    expect(marked.printed).not.toContain("PRIVATE");
    const overflow = await runCase("orphan", fakeHelper({ stdout: "PRIVATE".repeat(700) }));
    expect(overflow.error.message).toBe("owner-stimulus-retirement");
    expect(overflow.entry).toMatchObject({ truncated: true, refusal: "unrecognized", generatedTree: null });
    expect(overflow.printed).not.toContain("PRIVATE");
  });

  it("foreign retirement bytes are unchanged and carry no generated-tree observation", async () => {
    const helper = fakeHelper({
      ready: '{"constructed": true, "children": 1, "mode": "foreign"}\n',
      stdout: retired,
    });
    const run = await runCase("foreign", helper);
    expect(run.value).toBe(true);
    expect(run.entry).toMatchObject({ exactRetirement: true, generatedTree: null });
    const extra = await runCase(
      "foreign",
      fakeHelper({ ready: '{"constructed": true, "children": 1, "mode": "foreign"}\n', stdout: observed + retired }),
    );
    expect(extra.entry.exactRetirement).toBe(false);
  });
});

describe("closed stimulus diagnostics", () => {
  it("parses only allowlisted helper refusals", () => {
    expect(stimulusRefusal(Buffer.alloc(0))).toBeNull();
    expect(stimulusRefusal(Buffer.from(esrch))).toEqual({ stage: null, retirement: "member-read-ESRCH" });
    expect(
      stimulusRefusal(
        Buffer.from(
          "provider-boundary-owner-stimulus-refused:lifetime\nprovider-boundary-owner-stimulus-refused:retirement:member-live\n",
        ),
      ),
    ).toEqual({ stage: "lifetime", retirement: "member-live" });
    for (const stderr of [
      "provider-boundary-owner-stimulus-refused:retirement\n",
      "provider-boundary-owner-stimulus-refused:retirement:member-read-ENOTDIR\n",
      "provider-boundary-owner-stimulus-refused:PRIVATE\n",
      esrch + esrch,
      esrch.trimEnd(),
      `${esrch}PRIVATE`,
    ])
      expect(stimulusRefusal(Buffer.from(stderr))).toBe("unrecognized");
  });

  it("parses only closed generated-tree states", () => {
    expect(stimulusObservation(Buffer.from(observed + retired))).toMatchObject({
      ready: "init-pre-exec",
      boundary: "final",
      generated: "changed",
    });
    for (const line of [
      observed.replace("generated=changed", "generated=foreign"),
      observed.replace("boundary=final", "boundary=PRIVATE"),
      observed.trimEnd(),
    ])
      expect(stimulusObservation(Buffer.from(line))).toBeNull();
  });

  it("names the observed census refusal: exact orphan 198/110 versus ambiguous 198/113", () => {
    const stdout =
      "provider-boundary-cleanup-stage:remove-installation\nprovider-boundary-installer-stage:source-location\nprovider-boundary-installer-stage:remove-ownership\nprovider-boundary-cleanup-installer-status:1\n";
    const refusal = (stage) => ({
      code: 1,
      signal: null,
      stdout,
      stderr: `provider-boundary-installer-refused:${stage}\nprovider-boundary-cleanup-refused:remove-installation\n`,
    });
    expect(refusalStage(refusal("remove-orphan-owner"))).toBe("remove-orphan-owner");
    expect(refusalStage(refusal("remove-ambiguous-owner"))).toBe("remove-ambiguous-owner");
    expect(refusalStage({ ...refusal("remove-orphan-owner"), stderr: "PRIVATE" })).toBe("unknown");
    expect(refusalStage(undefined)).toBe("unknown");
  });
});

describe("isolated 13c diagnostic selection (AC4/AC5)", () => {
  it("the default no-argument invocation selects the complete step", () => {
    expect(diagnosticSelection([])).toBeNull();
  });

  it.each([
    ["13c-alone", "alone", 0],
    ["13c-concurrent-live", "concurrent-live", 1],
  ])("allowlists %s at a fixed 20 iterations", (selector, mode, count) => {
    expect(diagnosticSelection(["--diagnostic", selector, "--out", DIAGNOSTIC_OUT])).toEqual({
      selector,
      mode,
      count,
      iterations: 20,
      out: DIAGNOSTIC_OUT,
    });
  });

  it.each([
    [["--diagnostic", "13c", "--out", DIAGNOSTIC_OUT]],
    [["--diagnostic", "13e-alone", "--out", DIAGNOSTIC_OUT]],
    [["--diagnostic", "13C-ALONE", "--out", DIAGNOSTIC_OUT]],
    [["--diagnostic", "13c-alone;id", "--out", DIAGNOSTIC_OUT]],
    [["--diagnostic", "13c-alone", "--out", "/tmp/summary.json"]],
    [["--diagnostic", "13c-alone"]],
    [["--diagnostic", "13c-alone", "--out", DIAGNOSTIC_OUT, "--count", "5"]],
    [["--count", "20"]],
  ])("refuses %j", (argv) => {
    expect(() => diagnosticSelection(argv)).toThrow("diagnostic-selector-refused");
  });

  const selection = diagnosticSelection(["--diagnostic", "13c-alone", "--out", DIAGNOSTIC_OUT]);
  const provenance = { head: "a".repeat(40), runId: "1", runAttempt: "1", job: "repetition" };
  const pass = (iteration) => ({ iteration, result: "pass", firstFailure: null });

  it("all green is a nongoverning no-reproduction subset, never full-step completion", () => {
    const report = diagnosticReport(
      selection,
      Array.from({ length: 20 }, (_, i) => pass(i + 1)),
      provenance,
    );
    expect(report.exitCode).toBe(0);
    expect(report.summary).toMatchObject({
      governing: false,
      proof: "NOT PROVEN",
      complete: true,
      passed: 20,
      notRun: 0,
      outcome: "no reproduction",
      ...provenance,
    });
    expect(report.marker).toBe(
      "installed-boundary diagnostic 13c-alone: SUBSET; iterations=20 passed=20 failed=0 not-run=0; no reproduction; NOT PROVEN; not the installed-boundary full step",
    );
    expect(report.marker).not.toContain("remaining controls");
  });

  it("retains every iteration and the first failure; partial evidence is incomplete", () => {
    const results = [pass(1), { iteration: 2, result: "fail", firstFailure: "13c-alone-stimulus-retirement" }, pass(3)];
    const reproduced = diagnosticReport(selection, results, provenance);
    expect(reproduced.exitCode).toBe(1);
    expect(reproduced.summary).toMatchObject({
      outcome: "reproduced",
      complete: false,
      notRun: 17,
      firstFailure: { iteration: 2, control: "13c-alone-stimulus-retirement" },
    });
    expect(reproduced.summary.results).toEqual(results);
    const partial = diagnosticReport(selection, [pass(1)], provenance);
    expect(partial).toMatchObject({ exitCode: 1, summary: { outcome: "incomplete", complete: false, notRun: 19 } });
    expect(diagnosticReport(selection, [], provenance).summary).toMatchObject({ outcome: "incomplete", notRun: 20 });
  });

  it("provenance keeps only exact identities", () => {
    expect(
      diagnosticProvenance({
        BOUNDARY_HEAD_SHA: "b".repeat(40),
        GITHUB_RUN_ID: "38020576739",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_JOB: "repetition",
      }),
    ).toEqual({ head: "b".repeat(40), runId: "38020576739", runAttempt: "1", job: "repetition" });
    expect(
      diagnosticProvenance({
        BOUNDARY_HEAD_SHA: "PRIVATE",
        GITHUB_RUN_ID: "0",
        GITHUB_RUN_ATTEMPT: "x",
        GITHUB_JOB: "/",
      }),
    ).toEqual({ head: null, runId: null, runAttempt: null, job: null });
  });

  it("the manual workflow offers exactly the module's selectors and keeps the full step's default invocation", () => {
    const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    const workflow = read(".github/workflows/browser-boundary-diagnostics.yml");
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
    expect(workflow).not.toMatch(/^\s+(?:pull_request|merge_group|push|schedule):/m);
    expect(workflow).toContain("        options:\n          - 13c-alone\n          - 13c-concurrent-live\n");
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).not.toMatch(/run:.*\$\{\{\s*inputs\./);
    const order = [
      "Refuse an unlisted selector before installation",
      "Install provider browser boundary",
      "Run isolated serial repetition",
      "Remove owned provider browser boundary",
    ].map((name) => workflow.indexOf(`- name: ${name}`));
    expect(order.every((index, position) => index > (order[position - 1] ?? -1))).toBe(true);
    expect(workflow).toMatch(/- name: Remove owned provider browser boundary\n {8}if: always\(\)\n/);
    expect(workflow).toContain(`--diagnostic "$SELECTOR" --out ${DIAGNOSTIC_OUT}`);
    expect(DIAGNOSTIC_ITERATIONS).toBe(20);
    const platform = read(".github/workflows/platform-pr.yml");
    expect(platform).toContain(
      "          node scripts/provider-object-disposition/browser-boundary/hosted-controls.mjs\n\n      - name: Remove owned provider browser boundary\n        if: always()\n",
    );
    expect(platform).not.toContain("--diagnostic");
  });
});
