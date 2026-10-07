import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertBrowserAdmission } from "../test-window-browser.mjs";

const execute = promisify(execFile);

export async function withInstallationCycle(id, test) {
  let primary;
  try {
    await test();
  } catch (error) {
    primary = error;
  }
  try {
    await installationCycle(id);
  } catch (error) {
    primary ??= error;
  }
  if (primary) throw primary;
}

export async function installationCycle(id) {
  for (const [name, args, timeout, prefix] of [
    ["ci-cleanup.sh", [], 5000, "cleanup"],
    ["ci-setup.sh", ["reinstall"], 120000, "setup"],
  ]) {
    const env = Object.fromEntries(
      [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "PNPM_HOME",
        "GITHUB_ACTIONS",
        "RUNNER_ENVIRONMENT",
        "ImageOS",
        "ImageVersion",
        "BOUNDARY_HEAD_SHA",
      ]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    );
    try {
      const { stdout, stderr } = await execute("/bin/bash", [fileURLToPath(new URL(name, import.meta.url)), ...args], {
        env,
        timeout,
        maxBuffer: 1048576,
        encoding: "buffer",
      });
      assert.equal(stderr.length, 0);
      assert.ok(
        stdout
          .subarray(-`provider-boundary-${prefix}-stage:complete\n`.length)
          .equals(Buffer.from(`provider-boundary-${prefix}-stage:complete\n`)),
      );
      console.log(`installed-boundary per-case ${id} ${prefix}: complete; status=0; exact-end=true`);
    } catch (error) {
      console.error(
        `installed-boundary per-case ${id} ${prefix}: FAIL; ${JSON.stringify({
          status: Number.isInteger(error.code) ? error.code : null,
          signal: ["SIGTERM", "SIGKILL"].includes(error.signal) ? error.signal : null,
          stdoutBytes: error.stdout?.length ?? null,
          stderrBytes: error.stderr?.length ?? null,
          redacted: true,
          truncated: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        })}`,
      );
      throw new Error("per-case-installation-incomplete");
    }
  }
  await assertBrowserAdmission();
}
