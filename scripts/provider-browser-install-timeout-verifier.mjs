import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { resolveInstallerIdentity, runInstaller, signalGroup } from "./provider-browser-install-timeout.mjs";

// Non-governing Linux proof only. No selector reaches the production installer.
assert.equal(process.platform, "linux");
const env = process.env;
const identity = await resolveInstallerIdentity(env, fetch, { jobName: "Synthetic browser installer timeout" });
const grandchild = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
const synthetic =
  'const { spawn } = require("node:child_process"); process.on("SIGTERM", () => {}); spawn(process.execPath, ["-e", process.argv[1]], { stdio: "inherit" }); setInterval(() => {}, 1000);';
let group;
let termAt;
let killAt;
let initial;
let killed = false;
const snapshots = [];
function observe(stage) {
  const ps = spawnSync("ps", ["-eo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 1_000, maxBuffer: 1024 * 1024 });
  assert.equal(ps.status, 0);
  const members = ps.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, pgid]) => Number(pgid) === group)
    .map(([pid, pgid, state]) => ({ pid: Number(pid), pgid: Number(pgid), state }));
  snapshots.push({ stage, elapsedMs: Math.round(performance.now() - started), members });
  console.log(`provider-browser-install-synthetic-group ${JSON.stringify({ ...identity, ...snapshots.at(-1) })}`);
  return members.filter(({ state }) => !state.startsWith("Z"));
}
const started = performance.now();
try {
  const resultPromise = runInstaller({
    identity,
    env,
    spawnImpl: (_command, _args, options) => {
      const child = spawn(process.execPath, ["-e", synthetic, grandchild], options);
      group = child.pid;
      return child;
    },
    signalGroupImpl: (pid, signal) => {
      assert.equal(pid, group);
      if (signal === "TERM") {
        termAt = performance.now();
        assert.ok(observe("before-TERM").length >= 2);
        signalGroup(pid, signal);
        assert.ok(observe("at-TERM").length >= 2);
      } else {
        assert.equal(signal, "KILL");
        killAt = performance.now();
        assert.ok(observe("after-5s-before-KILL").length >= 2);
        signalGroup(pid, signal);
        killed = true;
      }
    },
  });
  await delay(1_000);
  initial = observe("before-deadline");
  assert.ok(initial.length >= 2);
  const result = await resultPromise;
  assert.notEqual(result.status, 0);
  assert.equal(result.record.terminalOutcome, "timeout");
  assert.ok(termAt - started >= 600_000);
  assert.ok(killAt - termAt >= 5_000);
  await delay(250);
  assert.equal(observe("after-KILL").length, 0);
  console.log(
    `provider-browser-install-synthetic-proof ${JSON.stringify({ ...identity, termAfterMs: termAt - started, graceMs: killAt - termAt, status: result.status, terminalOutcome: result.record.terminalOutcome })}`,
  );
  appendFileSync(env.GITHUB_OUTPUT, "timeout_proven=true\n");
  process.exitCode = result.status;
} finally {
  if (group && !killed) {
    try {
      process.kill(-group, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
