import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const workflow = parseYaml(readFileSync(".github/workflows/platform-pr.yml", "utf8"));
const job = workflow.jobs["e2e-tests"];
const step = (name) => job.steps.find((candidate) => candidate.name === name);
const helper = path.resolve("scripts/install-playwright-chromium.sh");
const linuxPath = (value) =>
  process.platform === "win32" ? `/mnt/${value[0].toLowerCase()}${value.slice(2).replaceAll("\\", "/")}` : value;

// Windows author controls exercise the same Linux kernel via WSL, not Git Bash
// process emulation. Hosted Linux runs use the runner's native bash/sudo/proc.
function bash(source) {
  const args = ["-s", "--", linuxPath(helper)];
  const command = process.platform === "win32" ? "wsl.exe" : "bash";
  const result = spawnSync(command, process.platform === "win32" ? ["-d", "Ubuntu", "--", "bash", ...args] : args, {
    input: source,
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function control(body, fake, setup = "") {
  return bash(`set -euo pipefail
helper="$1"
scratch="$(mktemp -d /tmp/chase-playwright-control.XXXXXX)"
cleanup() {
  case "$scratch" in /tmp/chase-playwright-control.*) rm -rf -- "$scratch" ;; *) exit 1 ;; esac
}
trap cleanup EXIT
mkdir -p "$scratch/bin" "$scratch/browsers"
export PATH="$scratch/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$scratch/browsers"
export PLAYWRIGHT_INSTALL_ATTEMPT_SECONDS=1
export PLAYWRIGHT_INSTALL_GRACE_SECONDS=1
export PLAYWRIGHT_INSTALL_DELAY_SECONDS=1
export PLAYWRIGHT_INSTALL_OVERALL_SECONDS=8
cat > "$scratch/bin/pnpm" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
scratch="$(dirname "$(dirname "$0")")"
echo "$*" >> "$scratch/calls"
test "$(id -u)" = 0
test "$*" = 'exec playwright install --with-deps chromium'
${fake}
FAKE
chmod +x "$scratch/bin/pnpm"
${setup}
started=$SECONDS
${body}
echo "elapsed=$((SECONDS - started))"
echo "calls=$(wc -l < "$scratch/calls")"
if [ -f "$scratch/child" ]; then
  child="$(cat "$scratch/child")"
  test ! -e "/proc/$child"
  echo child-cleaned
fi
`);
}

describe("bounded Playwright Chromium installer", () => {
  it("installs once on immediate success, including privileged execution", () => {
    const result = control('bash "$helper"', "exit 0");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("calls=1");
  });

  it("retries one install failure only after the first tree is gone", () => {
    const result = control(
      'bash "$helper"',
      `if [ "$(wc -l < "$scratch/calls")" = 1 ]; then
  setsid bash -c 'trap "" TERM; echo $$ > "$1/child"; while :; do sleep 0.1; done' bash "$scratch" &
  while [ ! -f "$scratch/child" ]; do sleep 0.01; done
  exit 42
fi
test ! -e "/proc/$(cat "$scratch/child")"
exit 0`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("calls=2");
    expect(result.stdout).toContain("child-cleaned");
    expect(result.stderr).toContain("exit 42");
  });

  it("propagates repeated failure and emits the named final diagnostic", () => {
    const result = control(
      'set +e; bash "$helper"; status=$?; set -e; echo "status=$status"; test "$status" = 42',
      "exit 42",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("calls=2");
    expect(result.stderr).toContain("Playwright Chromium install failed: attempt 2: exit 42");
  });

  it.each(["metadata", "partial package body"])(
    "bounds a hung %s and cleans a termination-resistant detached root child",
    (phase) => {
      const result = control(
        'set +e; bash "$helper"; status=$?; set -e; test "$status" != 0',
        `echo '${phase}: partial progress'
setsid bash -c 'trap "" TERM; echo $$ > "$1/child"; while :; do sleep 0.1; done' bash "$scratch" &
while [ ! -f "$scratch/child" ]; do sleep 0.01; done
trap '' TERM
while :; do sleep 0.1; done`,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("calls=2");
      expect(result.stdout).toContain("child-cleaned");
      expect(result.stderr).toContain("Playwright Chromium install failed: attempt 2: attempt timeout");
      expect(Number(result.stdout.match(/elapsed=(\d+)/)[1])).toBeLessThanOrEqual(8);
    },
  );

  it("enforces the overall deadline even when the second attempt cannot use its full budget", () => {
    const result = control(
      'set +e; bash "$helper"; status=$?; set -e; test "$status" != 0',
      "trap '' TERM; while :; do sleep 0.1; done",
      "export PLAYWRIGHT_INSTALL_ATTEMPT_SECONDS=3 PLAYWRIGHT_INSTALL_OVERALL_SECONDS=4",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(Number(result.stdout.match(/elapsed=(\d+)/)[1])).toBeLessThanOrEqual(4);
    expect(result.stderr).toContain("Playwright Chromium install failed");
    expect(result.stdout).toContain("calls=1");
  });

  it("does not retry external cancellation and cleans its owned child", () => {
    const result = control(
      `bash "$helper" & installer=$!
while [ ! -f "$scratch/child" ]; do sleep 0.01; done
kill -TERM "$installer"
set +e; wait "$installer"; status=$?; set -e
test "$status" != 0`,
      "echo $$ > \"$scratch/child\"; trap '' TERM; while :; do sleep 0.1; done",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("calls=1");
    expect(result.stdout).toContain("child-cleaned");
    expect(result.stderr).toContain("external cancellation");
  });

  it.each(["cold", "complete", "incomplete", "version-change"])(
    "still runs the dependency/browser installer for a %s cache",
    (cache) => {
      const setup =
        cache === "cold" ? "" : `touch "$scratch/browsers/${cache === "version-change" ? "old-version" : "chromium"}"`;
      const result = control(
        'bash "$helper"; test -f "$PLAYWRIGHT_BROWSERS_PATH/chromium"; test -f "$PLAYWRIGHT_BROWSERS_PATH/chromium-headless-shell"; test -f "$scratch/os-dependencies"',
        'touch "$PLAYWRIGHT_BROWSERS_PATH/chromium" "$PLAYWRIGHT_BROWSERS_PATH/chromium-headless-shell" "$scratch/os-dependencies"',
        setup,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("calls=1");
    },
  );

  it("rejects relative browser paths and larger-than-authorized budgets before spawning", () => {
    for (const setup of [
      "export PLAYWRIGHT_BROWSERS_PATH='~/.cache/ms-playwright'",
      "export PLAYWRIGHT_INSTALL_ATTEMPT_SECONDS=181",
    ]) {
      const result = control(
        'set +e; bash "$helper"; status=$?; set -e; test "$status" != 0; test ! -f "$scratch/calls"; touch "$scratch/calls"',
        "exit 0",
        setup,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("calls=0");
      expect(result.stderr).toContain("Playwright Chromium install failed");
    }
  });
});

describe("Platform PR install composition", () => {
  it("shares one absolute HOME-derived path and isolates exact installed-version/OS/architecture cache identity", () => {
    const resolve = step("Resolve Playwright Chromium cache");
    const cache = step("Cache Playwright Chromium");
    expect(resolve.run).toContain('browser_path="${HOME}/.cache/ms-playwright"');
    expect(resolve.run).toContain("pnpm exec playwright --version");
    expect(resolve.run).toContain('echo "PLAYWRIGHT_BROWSERS_PATH=${browser_path}" >> "$GITHUB_ENV"');
    expect(cache.with.path).toBe("${{ steps.playwright-chromium.outputs.browser-path }}");
    expect(cache.with.key).toBe(
      "e2e-playwright-chromium-${{ runner.os }}-${{ runner.arch }}-${{ steps.playwright-chromium.outputs.version }}",
    );
    expect(cache.with["restore-keys"]).toBeUndefined();
    expect(step("Run marketplace e2e suites").env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
    expect(cache.uses).toBe("actions/cache@caa296126883cff596d87d8935842f9db880ef25");
  });

  it("keeps job/suite/evidence contracts and always installs, including cache hits", () => {
    const install = step("Install Playwright Chromium");
    expect(job["timeout-minutes"]).toBe(25);
    expect(job.name).toBe("E2E Tests (${{ matrix.suite_batch }})");
    expect(job.strategy["fail-fast"]).toBe(false);
    expect(install.run).toBe("bash ./scripts/install-playwright-chromium.sh");
    expect(install["timeout-minutes"]).toBe(7);
    expect(install.if).toBeUndefined();
    expect(install["continue-on-error"]).toBeUndefined();
    expect(step("Run marketplace e2e suites").run).toContain('pnpm run test:e2e:suite "${{ matrix.suite_batch }}"');
    expect(step("Prepare sanitized operator extension evidence").if).toContain(
      "steps.e2e-producer.outcome != 'skipped'",
    );
    expect(step("Upload successful responsive evidence").if).toBe(
      "steps.responsive-evidence.outputs.publish == 'true'",
    );
  });

  it("a real helper failure skips the suite and the actual PR Required shell rejects its failure", () => {
    const result = control(
      'set +e; bash "$helper" && touch "$scratch/suite-ran"; status=$?; set -e; test "$status" != 0; test ! -f "$scratch/suite-ran"',
      "exit 42",
    );
    expect(result.status, result.stderr).toBe(0);
    const required = workflow.jobs["pr-required"].steps.find(
      (candidate) => candidate.name === "Verify required jobs",
    ).run;
    const rendered = required.replace(/\$\{\{([^}]+)\}\}/g, (_, expression) =>
      expression.includes(".result") ? (expression.includes("e2e-tests") ? "failure" : "success") : "true",
    );
    const gate = bash(rendered);
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain("E2E Tests was required but finished with result 'failure'");
  });
});
