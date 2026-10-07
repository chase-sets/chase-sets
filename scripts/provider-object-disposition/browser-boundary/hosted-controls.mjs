import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, lstat, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { acquireHeavySlot } from "../../lib/heavy-slot.mjs";
import { assertBrowserAdmission, openConfinedBrowser } from "../test-window-browser.mjs";
import { browserCapabilityProof, liveRemovalRefusal, mediationDiagnostic, observerDiagnostic } from "./protocol.mjs";

const execute = promisify(execFile);
const observer =
  "/usr/local/lib/chase-sets-provider-window-input/scripts/provider-object-disposition/browser-boundary/observe.py";
const install = "/usr/local/lib/chase-sets-provider-window";
const input = "/usr/local/lib/chase-sets-provider-window-input";
const environment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };
let control = "host-admission";
const pass = (id) => console.log(`installed-boundary control ${id}: PASS`);

async function tree() {
  const { stdout, stderr } = await execute("/usr/bin/sudo", ["-n", "/usr/bin/python3", observer, String(process.pid)], {
    env: environment,
    timeout: 1000,
    maxBuffer: 32768,
  }).catch((error) => {
    console.error(`installed-boundary observer:${JSON.stringify(observerDiagnostic(error))}`);
    throw new Error("observer-failed");
  });
  assert.equal(stderr, "");
  return JSON.parse(stdout);
}

async function drained(owned) {
  const started = performance.now();
  while (performance.now() - started < 2000) {
    const present = [];
    for (const owner of owned) {
      try {
        const stat = await readFile(`/proc/${owner.pid}/stat`, "utf8");
        const fields = stat
          .slice(stat.lastIndexOf(") ") + 2)
          .trim()
          .split(" ");
        if (Number(fields[19]) === owner.start) present.push(owner.pid);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      }
    }
    if (present.length === 0) return;
    await delay(20);
  }
  throw new Error("owned-drain-incomplete");
}

async function installationIdentity() {
  const files = await Promise.all(
    ["launcher.sha256", "files.sha256", "source.sha256"].map((name) => readFile(`${install}/${name}`)),
  );
  const directory = await lstat(input);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  const { stdout, stderr } = await execute(
    "/usr/bin/sudo",
    ["-n", "/usr/bin/cat", "/sys/kernel/security/apparmor/profiles"],
    {
      env: environment,
      timeout: 1000,
      maxBuffer: 65536,
    },
  );
  assert.equal(stderr, "");
  assert.equal(stdout.split("\n").filter((line) => line === "chase-sets-provider-window (unconfined)").length, 1);
  return { files, inputDevice: directory.dev, inputInode: directory.ino };
}

async function liveOwnerRefusal(contexts, owned, mode) {
  const before = await installationIdentity();
  let failure;
  try {
    await execute("/bin/bash", [`${input}/scripts/provider-object-disposition/browser-boundary/ci-cleanup.sh`], {
      env: environment,
      timeout: 5000,
      maxBuffer: 4096,
      encoding: "buffer",
    });
  } catch (error) {
    failure = error;
  }
  const exact = liveRemovalRefusal(failure);
  console.log(
    `installed-boundary control 13b refusal:${JSON.stringify({
      expectedStatus: 1,
      actualStatus: Number.isInteger(failure?.code) ? failure.code : null,
      exact,
      stdoutBytes: failure?.stdout?.length ?? null,
      stderrBytes: failure?.stderr?.length ?? null,
      redacted: true,
      truncated: failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    })}`,
  );
  assert.ok(exact);
  assert.deepEqual(await installationIdentity(), before);
  const after = await tree();
  for (const record of owned) {
    assert.ok(
      after.some(
        (r) =>
          r.pid === record.pid && r.start === record.start && r.parent === record.parent && r.image === record.image,
      ),
    );
  }
  for (const context of contexts) {
    const page = await context.newPage();
    await page.setContent("<!doctype html><title>SYNTHETIC_LIVE_OWNER_SURVIVES</title>");
    assert.equal(await page.title(), "SYNTHETIC_LIVE_OWNER_SURVIVES");
    await page.close();
  }
  pass(`13b ${mode} refusal and functional survival`);
}

async function setupNamesAbsent() {
  for (const name of [
    "launcher.original",
    "unprofiled-comparison",
    "wrong.profile",
    "hosts.original",
    "launcher.held",
    "original",
  ]) {
    await assert.rejects(lstat(`${install}/${name}`), (error) => error.code === "ENOENT");
  }
}

async function run() {
  assert.equal(process.platform, "linux");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.ImageOS, "ubuntu24");
  acquireHeavySlot("playwright");
  control = "12-setup-temporaries";
  await setupNamesAbsent();
  pass("12 setup temporaries absent");
  control = "1";
  const admission = await assertBrowserAdmission();
  console.log(`installed-boundary source-sha256:${admission.sourceDigest}`);
  for (const name of ["launcher.sha256", "source.sha256"]) {
    const value = (await readFile(`${install}/${name}`, "utf8")).trim();
    assert.match(value, /^[a-f0-9]{64}$/);
    console.log(`installed-boundary ${name}:${value}`);
  }
  pass("1 CP-T/CP-A");
  control = "5-launch";
  const browser = await openConfinedBrowser();
  let owned = [];
  let primary;
  let concurrent;
  try {
    control = "5-context";
    const context = await browser.newContext();
    control = "5-page";
    const page = await context.newPage();
    control = "5-memory-content";
    await page.setContent("<!doctype html><title>SYNTHETIC_BOUNDARY_CONTROL</title><p>memory-only</p>");
    assert.equal(await page.title(), "SYNTHETIC_BOUNDARY_CONTROL");
    control = "5-tree-observation";
    owned = await tree();
    console.log(`installed-boundary owned-identities:${JSON.stringify(owned)}`);
    control = "11-roots";
    assert.ok(owned.some((r) => r.image === "launcher" && r.pidNamespace === "host"));
    assert.ok(owned.some((r) => r.image === "launcher" && r.pidNamespace === "isolated"));
    assert.ok(owned.some((r) => r.image === "chrome"));
    for (const r of owned) {
      control = "6-label";
      assert.equal(r.label, "expected");
      control = "5-network";
      assert.equal(r.network, "isolated");
      control = "5-capabilities";
      assert.ok(browserCapabilityProof(r));
      if (r.image === "chrome") {
        control = "5-private-root";
        assert.equal(r.hostHelper, false);
        assert.equal(r.oldRootDetached, true);
        assert.ok(["path-checked", "private-proc-fdinfo"].includes(r.rootObservation));
      }
      const parent = owned.find((p) => p.pid === r.parent);
      control = "11-binding";
      if (parent) assert.ok(parent.start <= r.start);
    }
    control = "13b-live-owner";
    await liveOwnerRefusal([context], owned, "single-live");
    control = "13b-concurrent-live";
    concurrent = await openConfinedBrowser();
    const concurrentContext = await concurrent.newContext();
    const concurrentPage = await concurrentContext.newPage();
    await concurrentPage.setContent("<!doctype html><title>SYNTHETIC_CONCURRENT_OWNER</title>");
    assert.equal(await concurrentPage.title(), "SYNTHETIC_CONCURRENT_OWNER");
    owned = await tree();
    await liveOwnerRefusal([context, concurrentContext], owned, "concurrent-live");
  } catch (error) {
    primary = { error, control };
  } finally {
    if (concurrent) {
      try {
        await concurrent.close();
        console.log("installed-boundary concurrent-browser-close: completed");
      } catch (error) {
        console.log("installed-boundary concurrent-browser-close: failed; raw output redacted");
        primary ??= { error, control: "13b-concurrent-close" };
      }
    }
    try {
      await browser.close();
      console.log("installed-boundary browser-close: completed");
    } catch (error) {
      console.log("installed-boundary browser-close: failed; raw output redacted");
      primary ??= { error, control: "5-close" };
    }
  }
  if (primary) {
    control = primary.control;
    throw primary.error;
  }
  pass("5 CP-B sandboxed Chromium");
  pass("6 exec/descendant labels");
  pass("11 PID/start ownership");
  control = "16-close";
  await drained(owned);
  pass("16-close owned drain");
  control = "12-launch-temporaries";
  assert.deepEqual(await readdir(`${install}/root/tmp`), []);
  pass("12 launch host temporaries absent");
  console.log("installed-boundary remaining controls: NOT PROVEN; see boundary README");
}

run().catch((error) => {
  const diagnostic = mediationDiagnostic(error);
  if (diagnostic) console.error(`installed-boundary mediation:${JSON.stringify(diagnostic)}`);
  console.error(`installed-boundary control ${control}: FAIL; raw output redacted`);
  process.exitCode = 1;
});
