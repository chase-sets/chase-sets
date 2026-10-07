import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { assertBrowserAdmission, BROWSER_LAUNCHER } from "../test-window-browser.mjs";
import { ADMISSION, TRANSITION, nativeRefusal } from "./protocol.mjs";
import { installationCycle } from "./installation-cycle.mjs";
import { withPeerHolder } from "./peer-controls.mjs";

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
  }).catch((error) => {
    const stage =
      ["arguments", "rewrite", "backup", "inventory", "compile", "publish", "restore", "owned"].find((name) =>
        error.stderr?.equals(Buffer.from(`provider-boundary-variant-refused:${name}\n`)),
      ) ?? "unknown";
    console.error(
      `installed-boundary variant-helper:${JSON.stringify({
        stage,
        status: Number.isInteger(error.code) ? error.code : null,
        signal: ["SIGTERM", "SIGKILL"].includes(error.signal) ? error.signal : null,
        stdoutBytes: error.stdout?.length ?? null,
        stderrBytes: error.stderr?.length ?? null,
        redacted: true,
        truncated: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      })}`,
    );
    throw new Error("variant-helper-refused");
  });
  assert.equal(stderr.length, 0);
  return stdout.toString("utf8");
}

export async function identities(pid) {
  const records = JSON.parse(await command("owned", String(pid)));
  assert.ok(records.some((record) => record.pid === pid));
  for (const record of records) {
    const parent = records.find((candidate) => candidate.pid === record.parent);
    if (parent) assert.ok(record.start >= parent.start);
  }
  return records;
}

export async function absent(records) {
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

export function launch(sourceDigest, mode = "probe") {
  assert.ok(["probe", "browser"].includes(mode));
  const child = spawn(BROWSER_LAUNCHER, [mode, sourceDigest], {
    env: environment,
    stdio: mode === "probe" ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "pipe", "pipe"],
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
  let recovered = false;
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
      await installationCycle(name);
      recovered = !primary?.cleanupUnknown;
    } catch (error) {
      console.error("installed-boundary synthetic-build restore: FAIL; raw output redacted");
      primary ??= error;
    }
  }
  if (primary) {
    primary.recovered = recovered;
    throw primary;
  }
  pass(`${name} restored admission and exact host temporary absence`);
}

export async function withConcurrentBrowser(sourceDigest, test) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    executablePath: BROWSER_LAUNCHER,
    ignoreDefaultArgs: true,
    args: ["browser", sourceDigest],
    env: environment,
    chromiumSandbox: true,
    timeout: 5000,
  });
  let roots = [];
  let primary;
  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      offline: true,
      acceptDownloads: false,
      permissions: [],
    });
    const page = await context.newPage();
    await page.setContent("<!doctype html><title>SYNTHETIC_CONCURRENT_SURVIVAL</title>");
    roots = (await identities(process.pid)).filter((record) => record.image === "launcher");
    assert.equal(roots.length, 2);
    await test(async () => {
      const after = await identities(process.pid);
      for (const root of roots)
        assert.ok(
          after.some(
            (record) =>
              record.pid === root.pid &&
              record.start === root.start &&
              record.parent === root.parent &&
              record.image === root.image,
          ),
        );
      const check = await context.newPage();
      await check.setContent("<!doctype html><title>SYNTHETIC_CONCURRENT_SURVIVAL</title>");
      assert.equal(await check.title(), "SYNTHETIC_CONCURRENT_SURVIVAL");
      await check.close();
    });
  } catch (error) {
    primary = error;
  } finally {
    try {
      await browser.close();
      await absent(roots);
    } catch (error) {
      primary ??= error;
      primary.cleanupUnknown = true;
    }
  }
  if (primary) throw primary;
}

export async function nativeControls(stage) {
  const failures = [];
  const runCase = async (name, test) => {
    stage(name);
    try {
      await withVariant(name, test);
    } catch (error) {
      console.error(
        `installed-boundary control ${name}: FAIL; raw output redacted; restored=${error.recovered === true}`,
      );
      if (error.recovered !== true) throw error;
      failures.push(name);
    }
  };
  const refusalCases = [
    ["ready-outer", "", "seed-deadline"],
    ["reap-outer", "", "seed-reap"],
    ["ready-nested", TRANSITION, "seed-deadline"],
    ["reap-nested", TRANSITION, "seed-reap"],
    ["map-write", "", "mapping-write"],
    ["ancestry", "", "namespace-identity"],
    ["b3-failure", "", "namespace-identity"],
    ...["open", "socket", "connect", "recvmsg", "setns", "unshare", "mount", "clone", "prctl", "x32"].map((name) => [
      `sf-${name}`,
      [2, 3].map((code) => `SYNTHETIC_SF:1:0:${code}:31\nSYNTHETIC_SF:SIGSYS\n`),
      "namespace-seed",
    ]),
  ];
  await runCase("direct-clients", async (digest) => {
    const actual = await launch(digest).result;
    const expected =
      TRANSITION +
      [2, 10].flatMap((family) => [1, 2].map((kind) => `SYNTHETIC_EGRESS:${family}:${kind}:101\n`)).join("") +
      ADMISSION;
    const exact =
      actual.code === 0 &&
      actual.signal === null &&
      !actual.overflow &&
      actual.stdout.equals(Buffer.from(expected)) &&
      actual.stderr.length === 0;
    console.log(
      `installed-boundary native-egress:${JSON.stringify({
        expectedStatus: 0,
        actualStatus: actual.code,
        signal: actual.signal,
        exact,
        parentSends: 0,
        stdoutBytes: actual.stdout.length,
        stderrBytes: actual.stderr.length,
        redacted: true,
        truncated: actual.overflow,
      })}`,
    );
    assert.equal(exact, true);
  });
  for (const [name, stdout, refusal] of refusalCases) {
    stage(name);
    await runCase(name, async (digest) => {
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
        const seedMatch = /^SYNTHETIC_SF:(-1|0|1):(-1|0):([0-9]{1,2}):([0-9]{1,3})\n/.exec(
          actual.stdout.toString("ascii"),
        );
        const seedTermination = seedMatch
          ? {
              poll: Number(seedMatch[1]),
              wait: Number(seedMatch[2]),
              code: Number(seedMatch[3]),
              signal: Number(seedMatch[4]),
            }
          : null;
        const stderr = `provider-boundary-refused:${refusal}\n${name.endsWith("nested") ? "provider-boundary-refused:nested-sandbox\n" : ""}`;
        const exact =
          actual.code === 78 &&
          actual.signal === null &&
          !actual.overflow &&
          [stdout].flat().some((expected) => actual.stdout.equals(Buffer.from(expected))) &&
          actual.stderr.equals(Buffer.from(stderr));
        console.log(
          `installed-boundary native-control:${JSON.stringify({ name, expectedStatus: 78, actualStatus: actual.code, signal: actual.signal, seedTermination, nativeStage: nativeRefusal(actual.stdout, actual.stderr, actual.code), stdoutBytes: actual.stdout.length, stderrBytes: actual.stderr.length, exact, redacted: true, truncated: actual.overflow })}`,
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
          primary.cleanupUnknown = true;
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
      await runCase(name, async (digest) => {
        await withConcurrentBrowser(digest, async (survives) => {
          for (const signal of ["SIGKILL", "SIGTERM", "deadline"]) {
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
              if (signal !== "deadline") assert.equal(running.child.kill(signal), true);
              const actual = await running.result;
              const expectedSignal = signal === "deadline" ? "SIGTERM" : signal;
              const handled = expectedSignal === "SIGTERM" && scope === "nested";
              console.log(
                `installed-boundary termination:${JSON.stringify({ name, expectedSignal: handled ? null : expectedSignal, expectedStatus: handled ? 143 : null, actualSignal: actual.signal, actualStatus: actual.code, stdoutBytes: actual.stdout.length, stderrBytes: actual.stderr.length, redacted: true, truncated: actual.overflow })}`,
              );
              assert.equal(actual.code, handled ? 143 : null);
              assert.equal(actual.signal, handled ? null : expectedSignal);
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
                primary.cleanupUnknown = true;
              }
            }
            if (primary) throw primary;
            await survives();
            pass(`9/11/16 ${name} ${signal} exact status and owned drain`);
            pass(`14 ${name} ${signal} concurrent roots and functional survival`);
          }
        });
      });
    }
  }
  if (failures.length) {
    console.error(`installed-boundary failed native controls:${JSON.stringify(failures)}`);
    stage(failures[0]);
    throw new Error("native-controls-failed");
  }
  stage("15-peer-holder");
  await withVariant("stall-outer-B3", async (digest) => {
    const running = launch(digest);
    let records = [];
    let primary;
    try {
      const expected = Buffer.from("SYNTHETIC_TRANSITION:stall-outer-B3\n");
      const until = performance.now() + 2000;
      while (!running.output().equals(expected) && performance.now() < until) await delay(10);
      assert.equal(running.output().equals(expected), true);
      records = await identities(running.child.pid);
      const seed = records.find((record) => record.parent === running.child.pid);
      assert.ok(seed);
      await withPeerHolder(seed, async () => {
        assert.equal(running.child.kill("SIGKILL"), true);
        const result = await running.result;
        assert.equal(result.code, null);
        assert.equal(result.signal, "SIGKILL");
        assert.equal(result.stdout.equals(expected), true);
        assert.equal(result.stderr.length, 0);
        await absent(records);
      });
    } catch (error) {
      primary = error;
    } finally {
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
      await running.result;
      try {
        await absent(records);
      } catch (error) {
        primary ??= error;
        primary.cleanupUnknown = true;
      }
    }
    if (primary) throw primary;
  });
}
