import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { assertBrowserAdmission, BROWSER_LAUNCHER } from "../test-window-browser.mjs";
import { TRANSITION } from "./protocol.mjs";

const execute = promisify(execFile);
const helper =
  "/usr/local/lib/chase-sets-provider-window-input/scripts/provider-object-disposition/browser-boundary/native-variants.py";
const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
const pass = (id) => console.log(`installed-boundary control ${id}: PASS`);

async function command(...args) {
  const { stdout, stderr } = await execute("/usr/bin/sudo", ["-n", "/usr/bin/python3", helper, ...args], {
    env: environment,
    timeout: args[0] === "owned" ? 1000 : 15000,
    maxBuffer: 32768,
    encoding: "buffer",
  });
  assert.equal(stderr.length, 0);
  return stdout.toString("utf8");
}

async function identities(pid) {
  const records = JSON.parse(await command("owned", String(pid)));
  assert.ok(records.some((record) => record.pid === pid));
  for (const record of records) {
    const parent = records.find((candidate) => candidate.pid === record.parent);
    if (parent) assert.ok(record.start >= parent.start);
  }
  return records;
}

async function absent(records) {
  const until = performance.now() + 2000;
  do {
    let present = false;
    for (const record of records) {
      try {
        const stat = await readFile(`/proc/${record.pid}/stat`, "utf8");
        const fields = stat
          .slice(stat.lastIndexOf(") ") + 2)
          .trim()
          .split(/\s+/);
        if (Number(fields[19]) === record.start) present = true;
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
      }
    }
    if (!present) return;
    await delay(20);
  } while (performance.now() < until);
  throw new Error("owned-drain-incomplete");
}

function launch(sourceDigest) {
  const child = spawn(BROWSER_LAUNCHER, ["probe", sourceDigest], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let length = 0;
  let overflow = false;
  for (const [stream, chunks] of [
    [child.stdout, stdout],
    [child.stderr, stderr],
  ]) {
    stream.on("data", (chunk) => {
      length += chunk.length;
      if (length > 4096) {
        overflow = true;
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
  }
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), overflow }),
    );
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 5000);
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 6000);
  void result
    .finally(() => {
      clearTimeout(timer);
      clearTimeout(killTimer);
    })
    .catch(() => {});
  return { child, result, output: () => Buffer.concat(stdout) };
}

async function withVariant(name, test) {
  let primary;
  try {
    const identity = JSON.parse(await command("apply", name));
    assert.match(identity.sourceDigest, /^[a-f0-9]{64}$/);
    assert.match(identity.launcherDigest, /^[a-f0-9]{64}$/);
    console.log(`installed-boundary synthetic-build:${JSON.stringify({ name, ...identity })}`);
    await test(identity.sourceDigest);
  } catch (error) {
    primary = error;
  } finally {
    try {
      assert.equal(await command("restore"), "provider-boundary-variant:restored\n");
      await assertBrowserAdmission();
      assert.deepEqual(await readdir("/usr/local/lib/chase-sets-provider-window/root/tmp"), []);
    } catch (error) {
      console.error("installed-boundary synthetic-build restore: FAIL; raw output redacted");
      primary ??= error;
    }
  }
  if (primary) throw primary;
  pass(`${name} restored admission and exact host temporary absence`);
}

export async function nativeControls(stage) {
  const refusalCases = [
    ["ready-outer", "", "seed-deadline"],
    ["reap-outer", "", "seed-reap"],
    ["ready-nested", TRANSITION, "seed-deadline"],
    ["reap-nested", TRANSITION, "seed-reap"],
    ["map-write", "", "mapping-write"],
    ["b3-failure", "", "namespace-identity"],
    ...["open", "socket", "connect", "recvmsg", "setns", "unshare", "mount", "clone", "prctl", "x32"].map((name) => [
      `sf-${name}`,
      "SYNTHETIC_SF:SIGSYS\n",
      "namespace-seed",
    ]),
  ];
  for (const [name, stdout, refusal] of refusalCases) {
    stage(name);
    await withVariant(name, async (digest) => {
      const { child, result } = launch(digest);
      let records = [];
      let primary;
      try {
        if (name.startsWith("ready-") || name.startsWith("reap-")) {
          const until = performance.now() + 1500;
          const count = name.endsWith("nested") ? 4 : 2;
          do {
            records = await identities(child.pid);
            if (records.length >= count) break;
            await delay(10);
          } while (performance.now() < until && child.exitCode === null && child.signalCode === null);
          assert.ok(records.length >= count);
          console.log(`installed-boundary seed-identities:${JSON.stringify({ name, records })}`);
        }
        const actual = await result;
        const stderr = `provider-boundary-refused:${refusal}\n${name.endsWith("nested") ? "provider-boundary-refused:nested-sandbox\n" : ""}`;
        const exact =
          actual.code === 78 &&
          actual.signal === null &&
          !actual.overflow &&
          actual.stdout.equals(Buffer.from(stdout)) &&
          actual.stderr.equals(Buffer.from(stderr));
        console.log(
          `installed-boundary native-control:${JSON.stringify({ name, expectedStatus: 78, actualStatus: actual.code, signal: actual.signal, stdoutBytes: actual.stdout.length, stderrBytes: actual.stderr.length, exact, redacted: true, truncated: actual.overflow })}`,
        );
        assert.equal(exact, true);
      } catch (error) {
        primary = error;
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        try {
          await result;
          await absent(records);
        } catch (error) {
          primary ??= error;
        }
      }
      if (primary) throw primary;
      pass(name);
    });
  }
  for (const scope of ["outer", "nested"]) {
    for (let transition = 1; transition <= 6; transition++) {
      const name = `stall-${scope}-B${transition}`;
      stage(name);
      await withVariant(name, async (digest) => {
        for (const signal of ["SIGKILL", "SIGTERM"]) {
          const running = launch(digest);
          let records = [];
          let primary;
          try {
            const expected = (scope === "nested" ? TRANSITION : "") + `SYNTHETIC_TRANSITION:${name}\n`;
            const until = performance.now() + 2000;
            while (!running.output().equals(Buffer.from(expected)) && performance.now() < until) await delay(10);
            assert.equal(running.output().equals(Buffer.from(expected)), true);
            records = await identities(running.child.pid);
            assert.ok(records.length >= (scope === "nested" ? 4 : 2));
            console.log(`installed-boundary transition-identities:${JSON.stringify({ name, signal, records })}`);
            assert.equal(running.child.kill(signal), true);
            const actual = await running.result;
            const handled = signal === "SIGTERM" && scope === "nested";
            assert.equal(actual.code, handled ? 143 : null);
            assert.equal(actual.signal, handled ? null : signal);
            assert.equal(actual.overflow, false);
            assert.equal(actual.stdout.equals(Buffer.from(expected)), true);
            assert.equal(actual.stderr.length, 0);
          } catch (error) {
            primary = error;
          } finally {
            if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
            await running.result;
            try {
              await absent(records);
            } catch (error) {
              primary ??= error;
            }
          }
          if (primary) throw primary;
          pass(`9/11/16 ${name} ${signal} exact status and owned drain`);
        }
      });
    }
  }
}
