import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/playwright-chromium-install-diagnostics.yml", "utf8"));
const harness = readFileSync("scripts/playwright-chromium-install-diagnostics.mjs", "utf8");
const checkout = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const restore = "actions/cache/restore@caa296126883cff596d87d8935842f9db880ef25";
const upload = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const nodeCommand = (phase) => `node scripts/playwright-chromium-install-diagnostics.mjs ${phase}`;
const resolveCache = `set -euo pipefail
version="$(pnpm exec playwright --version | awk '{print $2}')"
test -n "$version"
browser_path="\${RUNNER_TEMP}/playwright-chromium/\${RUNNER_OS}/\${RUNNER_ARCH}/\${version}"
test ! -e "$browser_path"
{
  echo "browser-path=\${browser_path}"
  echo "version=\${version}"
} >> "$GITHUB_OUTPUT"
{
  echo "PLAYWRIGHT_BROWSERS_PATH=\${browser_path}"
  echo "DIAGNOSTIC_DIRECTORY=\${RUNNER_TEMP}/chromium-install-diagnostics"
  echo "DIAGNOSTIC_CACHE_KEY=e2e-playwright-chromium-\${RUNNER_OS}-\${RUNNER_ARCH}-\${version}"
} >> "$GITHUB_ENV"`;

function errors(candidate, source = harness) {
  const failures = [];
  const require = (condition, name) => {
    if (!condition) failures.push(name);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  require(same(candidate.on, { workflow_dispatch: null }), "manual-only/no-command-input");
  require(same(candidate.permissions, { contents: "read" }), "contents-read-only");
  require(same(candidate.concurrency, {
    group: "playwright-chromium-install-diagnostics",
    "cancel-in-progress": false,
  }), "no-auto-cancellation");
  require(same(Object.keys(candidate.jobs), ["diagnose"]), "isolated-job-only");
  const job = candidate.jobs.diagnose;
  require(job["runs-on"] === "ubuntu-latest" && job["timeout-minutes"] === 25, "unchanged-job-image-bound");
  require(job.if ===
    "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)", "trusted-default-branch-only");
  require(!job.needs && !job.environment, "no-Required-selector-environment-coupling");
  require(same(job.strategy, {
    "fail-fast": false,
    "max-parallel": 2,
    matrix: { route: ["combined", "decomposed"], cache: ["cold", "hit"] },
  }), "fixed-four-cell-matrix");
  const steps = job.steps;
  require(steps.length === 8, "fixed-step-inventory");
  require(steps[0].uses === checkout && steps[0].with?.["persist-credentials"] === false, "credential-free-checkout");
  require(steps[1].uses === "./.github/actions/setup-pnpm-workspace" &&
    steps[1].with?.install === true, "same-frozen-setup");
  require(steps[2].id === "cache-path" && steps[2].run.trim() === resolveCache, "empty-owned-exact-version-cache");
  require(steps[3].uses === restore &&
    steps[3].if === "matrix.cache == 'hit'" &&
    same(steps[3].with, {
      path: "${{ steps.cache-path.outputs.browser-path }}",
      key: "e2e-playwright-chromium-${{ runner.os }}-${{ runner.arch }}-${{ steps.cache-path.outputs.version }}",
    }), "hit-only-exact-restore/no-write");
  require(steps[4].id === "prepare" &&
    steps[4].run === nodeCommand("prepare") &&
    steps[4].env.DIAGNOSTIC_RESTORED === "${{ steps.restore.outputs.cache-hit }}", "pre-attempt-control");
  require(steps[5].id === "install" &&
    steps[5].run === nodeCommand("measure") &&
    steps[5].if === "steps.prepare.outputs.eligible == 'true'" &&
    steps[5]["timeout-minutes"] === 7, "unchanged-step-bound/eligible-only");
  require(steps[6].run === nodeCommand("finalize") && steps[6].if === "always()", "all-terminal-outcomes");
  require(steps[7].uses === upload &&
    steps[7].if === "always()" &&
    steps[7].with["if-no-files-found"] === "error", "retain-failed-cells");
  const encoded = JSON.stringify(candidate);
  require(!/secrets\.|environment|continue-on-error|restore-keys|actions\/cache@|actions\/cache\/save|pull_request|merge_group/.test(
    encoded,
  ), "no-credentials-publication-or-Required-coupling");
  require(!/process\.argv\[3\]|eval\(|setTimeout\(|\.kill\(|AbortSignal\.timeout|shell:\s*true/.test(
    source,
  ), "no-arbitrary-command-or-second-supervisor");
  require(source.includes("options.timeoutSeconds !== 180") &&
    source.includes('options.env.PLAYWRIGHT_INSTALL_POLICY !== "diagnostic-retry"'), "attempt-budget-and-policy");
  require(source.includes('installerArgs: [self, "install-phases"]') &&
    source.includes("const result = await install({") &&
    source.includes("...composeAttempt(options, route)") &&
    source.includes("supervise = runInstaller") &&
    source.includes("install = installPlaywrightChromium"), "same-helper-and-real-supervisor");
  require(source.includes("return measured.result.status;") &&
    source.includes("if (status !== 0) return status;"), "nonzero-not-swallowed");
  require(source.includes('"exec", "playwright", "install-deps", "chromium"') &&
    source.includes('"exec", "playwright", "install", "chromium"'), "fixed-capability-preserving-commands");
  return failures;
}

describe("manual diagnostic workflow contract", () => {
  it("keeps the complete accepted workflow and real-lifecycle composition isolated", () => {
    expect(errors(workflow)).toEqual([]);
  });

  it.each([
    [
      "changed event",
      (value) => {
        value.on.pull_request = null;
      },
    ],
    [
      "arbitrary command input",
      (value) => {
        value.on.workflow_dispatch = { inputs: { command: { type: "string" } } };
      },
    ],
    [
      "privileged token",
      (value) => {
        value.permissions.actions = "write";
      },
    ],
    [
      "secret inheritance",
      (value) => {
        value.jobs.diagnose.env.PRIVATE = "${{ secrets.PRIVATE }}";
      },
    ],
    [
      "environment",
      (value) => {
        value.jobs.diagnose.environment = "staging";
      },
    ],
    [
      "Required coupling",
      (value) => {
        value.jobs.diagnose.needs = "PR Required";
      },
    ],
    [
      "selector coupling",
      (value) => {
        value.jobs.diagnose.needs = "change-scope";
      },
    ],
    [
      "changed attempt backstop",
      (value) => {
        value.jobs.diagnose.steps[5]["timeout-minutes"] = 8;
      },
    ],
    [
      "changed job bound",
      (value) => {
        value.jobs.diagnose["timeout-minutes"] = 26;
      },
    ],
    [
      "third arm",
      (value) => {
        value.jobs.diagnose.strategy.matrix.route.push("browser-only");
      },
    ],
    [
      "changed parallelism",
      (value) => {
        value.jobs.diagnose.strategy["max-parallel"] = 4;
      },
    ],
    [
      "persistent checkout",
      (value) => {
        value.jobs.diagnose.steps[0].with["persist-credentials"] = true;
      },
    ],
    [
      "cache write",
      (value) => {
        value.jobs.diagnose.steps[3].uses = restore.replace("/restore", "");
      },
    ],
    [
      "prefix restore",
      (value) => {
        value.jobs.diagnose.steps[3].with["restore-keys"] = "e2e-playwright";
      },
    ],
    [
      "cold restore",
      (value) => {
        delete value.jobs.diagnose.steps[3].if;
      },
    ],
    [
      "cold-as-hit bypass",
      (value) => {
        delete value.jobs.diagnose.steps[5].if;
      },
    ],
    [
      "native warmup",
      (value) => {
        value.jobs.diagnose.steps[2].run += "\npnpm exec playwright install-deps chromium";
      },
    ],
    [
      "swallowed workflow exit",
      (value) => {
        value.jobs.diagnose.steps[5]["continue-on-error"] = true;
      },
    ],
    [
      "arbitrary shell",
      (value) => {
        value.jobs.diagnose.steps[5].run = "${{ inputs.command }}";
      },
    ],
    [
      "success-only upload",
      (value) => {
        value.jobs.diagnose.steps[7].if = "success()";
      },
    ],
  ])("rejects governing-variable-only bypass mutant: %s", (_name, mutate) => {
    const mutant = structuredClone(workflow);
    mutate(mutant);
    expect(errors(mutant).length).toBeGreaterThan(0);
  });

  it.each([
    ["changed shared bound", "options.timeoutSeconds !== 180", "options.timeoutSeconds !== 181"],
    [
      "retired retry policy",
      'options.env.PLAYWRIGHT_INSTALL_POLICY !== "diagnostic-retry"',
      'options.env.PLAYWRIGHT_INSTALL_POLICY !== "e2e-retry"',
    ],
    ["swallowed measured exit", "return measured.result.status;", "return 0;"],
    ["swallowed phase exit", "if (status !== 0) return status;", "if (status !== 0) return 0;"],
    ["second timeout loop", "const monotonic =", "setTimeout(() => {}, 180000);\nconst monotonic ="],
    ["replaced supervisor", "supervise = runInstaller", "supervise = fakeInstaller"],
  ])("rejects source bypass mutant: %s", (_name, before, after) => {
    expect(harness).toContain(before);
    expect(errors(workflow, harness.replace(before, after)).length).toBeGreaterThan(0);
  });
});
