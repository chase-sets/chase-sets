import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, lstat, stat, readdir, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { dirname } from "node:path";
import { acquireHeavySlot } from "../../lib/heavy-slot.mjs";
import { assertBrowserAdmission, BROWSER_LAUNCHER, openConfinedBrowser } from "../test-window-browser.mjs";
import { browserCapabilityProof, removalRefusal, mediationDiagnostic, observerDiagnostic } from "./protocol.mjs";
import { bootstrapControls } from "./bootstrap-controls.mjs";
import { nativeDiagnosticControls } from "./native-diagnostics.mjs";
import { nativeControls } from "./native-controls.mjs";
import { peerControls } from "./peer-controls.mjs";
import {
  diagnosticProvenance,
  diagnosticReport,
  diagnosticSelection,
  refusalStage,
  withOwnershipStimulus,
} from "./ownership-controls.mjs";
import { browserLifecycleControls } from "./browser-lifecycle-controls.mjs";
import { installationCycle, withInstallationCycle } from "./installation-cycle.mjs";
import { assertIdentitySurvival } from "./identity-controls.mjs";

const execute = promisify(execFile);
const observer =
  "/usr/local/lib/chase-sets-provider-window-input/scripts/provider-object-disposition/browser-boundary/observe.py";
const install = "/usr/local/lib/chase-sets-provider-window";
const input = "/usr/local/lib/chase-sets-provider-window-input";
const environment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };
let control = "host-admission";
let observations = null;
const pass = (id) => console.log(`installed-boundary control ${id}: PASS`);

async function launchIdentities(mode, value) {
  try {
    const { stdout, stderr } = await execute(
      "/usr/bin/sudo",
      [
        "-n",
        "/usr/bin/python3",
        `${input}/scripts/provider-object-disposition/browser-boundary/identity-controls.py`,
        mode,
        ...(mode === "baseline" ? [String(process.pid), String(value)] : [value.map(({ pid }) => pid).join(",")]),
      ],
      { env: environment, timeout: 1000, maxBuffer: 4096 },
    );
    assert.equal(stderr, "");
    return JSON.parse(stdout);
  } catch (error) {
    console.error(
      `installed-boundary identity-observer:${JSON.stringify({
        mode,
        status: Number.isInteger(error.code) ? error.code : null,
        exact: error.stderr === "provider-boundary-identity-refused\n",
        redacted: true,
        truncated: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      })}`,
    );
    throw new Error("identity-observer-failed");
  }
}

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

async function installationIdentity(inputLink = false) {
  const files = await Promise.all(
    ["launcher.sha256", "files.sha256", "source.sha256"].map((name) => readFile(`${install}/${name}`)),
  );
  const directory = await (inputLink ? stat(input) : lstat(input));
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

async function ownerRefusal(contexts, owned, mode, stage, id, censusOwner) {
  // Survival is a reread of the readiness-bound L/I1/browser identities, never
  // a second global census or a replacement baseline under the cap stimulus.
  const survivalRecords = () => launchIdentities("survival", owned);
  const missingFrom = (records) =>
    owned
      .filter(
        (record) =>
          !records.some(
            (r) =>
              r.pid === record.pid &&
              r.start === record.start &&
              r.parent === record.parent &&
              r.image === record.image &&
              r.device === record.device &&
              r.inode === record.inode,
          ),
      )
      .map(({ pid, start, parent, image }) => ({ pid, start, parent, image }));
  control = `${id}-${mode}-installation-before`;
  const before = await installationIdentity(stage === "input-not-symlink");
  control = `${id}-${mode}-identity-before`;
  const beforeRemoval = await survivalRecords();
  const missingBeforeRemoval = missingFrom(beforeRemoval);
  console.log(
    `installed-boundary control ${id} identity-before:${JSON.stringify({ mode, beforeCount: owned.length, missingBeforeRemoval })}`,
  );
  assertIdentitySurvival(owned, beforeRemoval);
  control = `${id}-${mode}-refusal`;
  if (id === "13g") {
    const limits = await readFile(`/proc/${censusOwner.pid}/limits`, "utf8");
    const fileLimit = Number(/^Max open files\s+(\d+)/m.exec(limits)?.[1]);
    const processLimit = Number(/^Max processes\s+(\d+)/m.exec(limits)?.[1]);
    const ownerStat = await readFile(`/proc/${censusOwner.pid}/stat`, "utf8");
    assert.equal(
      Number(
        ownerStat
          .slice(ownerStat.lastIndexOf(") ") + 2)
          .trim()
          .split(/\s+/)[19],
      ),
      censusOwner.start,
    );
    assert.equal(fileLimit, censusOwner.fileLimit);
    assert.equal(processLimit, censusOwner.processLimit);
    const count = (await readdir("/proc")).filter((name) => /^[0-9]+$/.test(name)).length;
    assert.ok(count >= 4097);
    console.log(
      `installed-boundary control 13g ${mode} immediately-before-removal:${JSON.stringify({ processCount: count, fileLimit, processLimit, ownerStart: censusOwner.start, stimulusLive: true })}`,
    );
  }
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
  const exact = removalRefusal(failure, stage);
  const refusal = {
    expectedStatus: 1,
    actualStatus: Number.isInteger(failure?.code) ? failure.code : null,
    installerStatus: exact && !stage.startsWith("input-") ? 1 : null,
    exact,
    observedStage: refusalStage(failure),
    stdoutBytes: failure?.stdout?.length ?? null,
    stderrBytes: failure?.stderr?.length ?? null,
    redacted: true,
    truncated: failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  };
  observations?.refusals.push(refusal);
  console.log(`installed-boundary control ${id} refusal:${JSON.stringify(refusal)}`);
  assert.ok(exact);
  control = `${id}-${mode}-installation-after`;
  assert.deepEqual(await installationIdentity(stage === "input-not-symlink"), before);
  control = `${id}-${mode}-identity-survival`;
  const after = await survivalRecords();
  const missing = missingFrom(after);
  console.log(
    `installed-boundary control ${id} identity-survival:${JSON.stringify({
      mode,
      beforeCount: owned.length,
      afterCount: after.length,
      missingBeforeRemoval,
      missingAfterRemoval: missing,
    })}`,
  );
  assertIdentitySurvival(owned, after);
  for (const context of contexts) {
    control = `${id}-${mode}-new-page`;
    const page = await context.newPage();
    control = `${id}-${mode}-page-content`;
    await page.setContent("<!doctype html><title>SYNTHETIC_LIVE_OWNER_SURVIVES</title>");
    assert.equal(await page.title(), "SYNTHETIC_LIVE_OWNER_SURVIVES");
    control = `${id}-${mode}-page-close`;
    await page.close();
  }
  pass(`${id} ${mode} refusal${contexts.length ? " and functional survival" : ""}`);
}

async function missingOwnerKey(contexts, mode) {
  control = `13d-${mode}-identity-baseline`;
  const owned = await launchIdentities("baseline", contexts.length);
  const stimulus = `${input}/scripts/provider-object-disposition/browser-boundary/hosted-stimulus.py`;
  const mutate = async (action) => {
    const { stdout, stderr } = await execute("/usr/bin/sudo", ["-n", "/usr/bin/python3", stimulus, action], {
      env: environment,
      timeout: 1000,
      maxBuffer: 1024,
    });
    assert.equal(stdout, `provider-boundary-stimulus:missing-key-${action}\n`);
    assert.equal(stderr, "");
  };
  let primary;
  let applied = false;
  try {
    await mutate("apply");
    applied = true;
    await ownerRefusal(contexts, owned, mode, "remove-ownership-census", "13d");
  } catch (error) {
    primary = error;
  } finally {
    if (applied) {
      try {
        await mutate("restore");
      } catch (error) {
        console.error("installed-boundary control 13d restore: FAIL; raw output redacted");
        primary ??= error;
      }
    }
  }
  if (primary) throw primary;
  control = `13d-${mode}-restored-admission`;
  await assertBrowserAdmission();
  pass(`13d ${mode} restored admission`);
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

async function ownerCase(id, count, test) {
  let caseFailed = false;
  try {
    await ownerCaseCycle(id, count, test, () => {
      caseFailed = true;
    });
  } catch (error) {
    // The case's own first failure keeps its label; otherwise per-case cleanup failed.
    if (!caseFailed) control = `${id}-per-case-cleanup`;
    throw error;
  }
}

async function ownerCaseCycle(id, count, test, failed) {
  await withInstallationCycle(id, async () => {
    const browsers = [];
    const contexts = [];
    let owned = [];
    let primary;
    try {
      control = `${id}-browser-readiness`;
      for (let index = 0; index < count; index++) {
        const browser = await openConfinedBrowser();
        browsers.push(browser);
        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        await page.setContent("<!doctype html><title>SYNTHETIC_OWNER_CASE</title>");
      }
      control = `${id}-identity-baseline`;
      owned = await launchIdentities("baseline", count);
      await test(contexts, owned);
    } catch (error) {
      primary = error;
    } finally {
      for (const browser of browsers.reverse()) {
        try {
          await browser.close();
        } catch (error) {
          if (!primary) control = `${id}-browser-close`;
          primary ??= error;
        }
      }
      try {
        await drained(owned);
      } catch (error) {
        if (!primary) control = `${id}-browser-drain`;
        primary ??= error;
      }
    }
    if (primary) {
      failed();
      throw primary;
    }
  });
}

async function stimulusCase(id, mode, count, stimulus, stage, record) {
  await ownerCase(`${id}-${mode}`, count, async (contexts, owned) => {
    const constructed = await withOwnershipStimulus(
      stimulus,
      (result) => ownerRefusal(contexts, owned, mode, stage, id, result),
      undefined,
      {
        onPhase: (phase) => {
          control = `${id}-${mode}-stimulus-${phase}`;
        },
        record,
      },
    );
    control = `${id}-${mode}-restored-admission`;
    await assertBrowserAdmission();
    if (constructed) pass(`${id} ${mode} stimulus retired and admission restored`);
    else
      console.log(`installed-boundary control ${id} ${mode}: NOT CONSTRUCTED; cleanup and restored admission verified`);
  });
}

async function malformedPath(contexts, owned, mode, name, stage) {
  const before = await installationIdentity();
  const mutate = async (action) => {
    const { stdout, stderr } = await execute(
      "/usr/bin/sudo",
      [
        "-n",
        "/usr/bin/python3",
        `${input}/scripts/provider-object-disposition/browser-boundary/path-stimulus.py`,
        name,
        action,
      ],
      {
        env: environment,
        timeout: 1000,
        maxBuffer: 1024,
      },
    );
    assert.equal(stdout, `provider-boundary-path-stimulus:${name}-${action}\n`);
    assert.equal(stderr, "");
  };
  let applied = false;
  let primary;
  try {
    await mutate("apply");
    applied = true;
    await ownerRefusal(contexts, owned, mode, stage, "13h");
  } catch (error) {
    primary = error;
  } finally {
    if (applied) {
      try {
        await mutate("restore");
      } catch (error) {
        primary ??= error;
      }
    }
  }
  if (primary) throw primary;
  assert.deepEqual(await installationIdentity(), before);
  await assertBrowserAdmission();
}

async function ownershipCases() {
  for (const count of [1, 2]) {
    const mode = count === 1 ? "single-live" : "concurrent-live";
    await ownerCase(`13b-${mode}`, count, (contexts, owned) =>
      ownerRefusal(contexts, owned, mode, "remove-live-owner", "13b"),
    );
  }
  for (const count of [0, 1]) {
    const mode = count ? "concurrent-live" : "alone";
    await ownerCase(`13d-${mode}`, count, (contexts) => missingOwnerKey(contexts, mode));
    for (const [stimulus, stage, id] of [
      ["orphan", "remove-orphan-owner", "13c"],
      ["foreign", "remove-ambiguous-owner", "13e"],
      ["cap", "remove-ownership-census", "13g"],
    ]) {
      await stimulusCase(id, mode, count, stimulus, stage);
    }
    for (const [name, stage] of [
      ["target", "remove-target-symlink"],
      ["profile", "remove-profile-symlink"],
      ["input", "input-not-symlink"],
    ]) {
      if (name === "target" && count) continue;
      await ownerCase(`13h-${name}-${mode}`, count, (contexts, owned) =>
        malformedPath(contexts, owned, mode, name, stage),
      );
    }
  }
  for (const count of [0, 1]) {
    await ownerCase(`13h-owned-realpath-${count ? "concurrent-live" : "alone"}`, count, async (contexts, owned) => {
      const before = await installationIdentity();
      const { stdout, stderr } = await execute(
        "/usr/bin/python3",
        [`${input}/scripts/provider-object-disposition/browser-boundary/path-fixtures.py`],
        { env: environment, timeout: 5000, maxBuffer: 4096 },
      );
      assert.equal(stdout, "provider-boundary-owned-realpath:target-input-refusal-order-bypass:PASS\n");
      assert.equal(stderr, "");
      assert.deepEqual(await installationIdentity(), before);
      control = `13h-owned-realpath-${count ? "concurrent-live" : "alone"}-identity-survival`;
      const after = await launchIdentities("survival", owned);
      assertIdentitySurvival(owned, after);
      for (const context of contexts) {
        const page = await context.newPage();
        await page.setContent("<!doctype html><title>SYNTHETIC_REALPATH_SURVIVAL</title>");
        assert.equal(await page.title(), "SYNTHETIC_REALPATH_SURVIVAL");
        await page.close();
      }
      await assertBrowserAdmission();
      pass(
        `13h SYNTHETIC source-bound owned ancestor realpath/order/bypass ${count ? "and concurrent functional survival" : "alone"}`,
      );
    });
  }
}

async function partialRemovalCase() {
  await withInstallationCycle("18-partial-R3", async () => {
    const before = await installationIdentity();
    const admission = await assertBrowserAdmission();
    const mutate = async (action) => {
      const { stdout, stderr } = await execute(
        "/usr/bin/sudo",
        [
          "-n",
          "/usr/bin/python3",
          `${input}/scripts/provider-object-disposition/browser-boundary/r3-stimulus.py`,
          action,
        ],
        {
          env: environment,
          timeout: 7000,
          maxBuffer: 4096,
        },
      );
      assert.equal(stderr, "");
      assert.equal(
        stdout,
        action === "apply"
          ? "provider-boundary-r3-stimulus:apply;installer-signal=SIGKILL;exact-output=true\n"
          : "provider-boundary-r3-stimulus:restore\n",
      );
    };
    let applied = false;
    let primary;
    try {
      control = "18-R3-interrupt";
      await mutate("apply");
      applied = true;
      let native;
      try {
        await execute(BROWSER_LAUNCHER, ["probe", admission.sourceDigest], {
          env: environment,
          timeout: 5000,
          maxBuffer: 4096,
          encoding: "buffer",
        });
      } catch (error) {
        native = error;
      }
      const exact =
        native?.code === 78 &&
        !native.signal &&
        native.stdout.equals(Buffer.alloc(0)) &&
        native.stderr.equals(Buffer.from("provider-boundary-refused:attachment\n"));
      console.log(
        `installed-boundary partial-R3 native:${JSON.stringify({ status: Number.isInteger(native?.code) ? native.code : null, exact, stdoutBytes: native?.stdout?.length ?? null, stderrBytes: native?.stderr?.length ?? null, redacted: true })}`,
      );
      assert.equal(exact, true);
      await assert.rejects(
        assertBrowserAdmission(),
        (error) => mediationDiagnostic(error)?.nativeStage === "attachment",
      );
      let cleanup;
      try {
        await execute("/bin/bash", [`${input}/scripts/provider-object-disposition/browser-boundary/ci-cleanup.sh`], {
          env: environment,
          timeout: 5000,
          maxBuffer: 4096,
          encoding: "buffer",
        });
      } catch (error) {
        cleanup = error;
      }
      assert.equal(removalRefusal(cleanup, "remove-ownership-census"), true);
      for (const path of [
        `${install}/source/browser-boundary/installation.h`,
        "/etc/apparmor.d/chase-sets-provider-window",
      ])
        await assert.rejects(lstat(path), (error) => error.code === "ENOENT");
      assert.ok((await lstat(input)).isDirectory());
      console.log(
        "installed-boundary control 17/18 partial R3: inadmissible; next remove exact census refusal; externally disposed / unknown until explicit restoration",
      );
    } catch (error) {
      primary = error;
    } finally {
      if (applied) {
        try {
          await mutate("restore");
        } catch (error) {
          primary ??= error;
        }
      }
    }
    if (primary) throw primary;
    assert.deepEqual(await installationIdentity(), before);
    await assertBrowserAdmission();
  });
}

async function wholeInstallerFailure() {
  control = "18-whole-installer";
  await withInstallationCycle("18-whole-installer", async () => {
    const { chromium } = await import("@playwright/test");
    const { stdout, stderr } = await execute(
      "/usr/bin/sudo",
      [
        "-n",
        "/usr/bin/python3",
        `${input}/scripts/provider-object-disposition/browser-boundary/installer-failure.py`,
        dirname(chromium.executablePath()),
        process.env.ImageVersion,
      ],
      { env: environment, timeout: 125000, maxBuffer: 4096 },
    );
    assert.equal(stderr, "");
    assert.equal(
      stdout,
      "provider-boundary-whole-installer:synthetic-negative;installer=1;native=78;stage=negative-mapping-write-output;exact=true\n",
    );
    console.log(
      "installed-boundary control 18 whole installer: synthetic negative mismatch; exact native=78 and installer=1; first failure retained",
    );
  });
}

function hostedRunner() {
  assert.equal(process.platform, "linux");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.ImageOS, "ubuntu24");
  acquireHeavySlot("playwright");
}

// Isolated, nongoverning repetition of one allowlisted control. It never runs
// the full step and never prints the full step's terminal line.
async function diagnose(selection) {
  hostedRunner();
  const provenance = diagnosticProvenance(process.env);
  const results = [];
  const write = async () => {
    const report = diagnosticReport(selection, results, provenance);
    await mkdir(dirname(selection.out), { recursive: true });
    await writeFile(selection.out, `${JSON.stringify(report.summary, null, 2)}\n`);
    return report;
  };
  try {
    await write();
    control = "12-setup-temporaries";
    await setupNamesAbsent();
    control = "1";
    await assertBrowserAdmission();
    for (let iteration = 1; iteration <= selection.iterations; iteration++) {
      observations = { stimulus: null, refusals: [] };
      let failure;
      try {
        await stimulusCase("13c", selection.mode, selection.count, "orphan", "remove-orphan-owner", (entry) => {
          observations.stimulus = entry;
        });
      } catch (error) {
        failure = error;
      }
      results.push({
        iteration,
        result: failure ? "fail" : "pass",
        firstFailure: failure ? control : null,
        recovered: failure ? failure.recovered === true : null,
        stimulus: observations.stimulus,
        refusal: observations.refusals[0] ?? null,
      });
      console.log(
        `installed-boundary diagnostic ${selection.selector} iteration ${iteration}/${selection.iterations}: ${failure ? `FAIL; first failure ${control}; recovered=${failure.recovered === true}; raw output redacted` : "PASS"}`,
      );
      await write();
      // Only a verified per-case reinstall makes the next iteration meaningful.
      if (failure && failure.recovered !== true) break;
    }
  } finally {
    observations = null;
    const report = await write();
    console.log(report.marker);
    process.exitCode = report.exitCode;
  }
}

async function run() {
  hostedRunner();
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
  let observeHolders;
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
    control = "5-nested-browser-sandbox";
    assert.ok(owned.some((r) => r.image === "chrome" && r.userNamespace === "nested" && r.Seccomp === "2"));
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
    control = "7-peer-reach";
    observeHolders = await peerControls(await tree());
  } catch (error) {
    primary = { error, control };
  } finally {
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
  control = "15-holder-census";
  await observeHolders();
  control = "12-launch-temporaries";
  assert.deepEqual(await readdir(`${install}/root/tmp`), []);
  pass("12 launch host temporaries absent");
  await installationCycle("CP-B");
  await ownershipCases();
  await wholeInstallerFailure();
  await partialRemovalCase();
  control = "B2-bootstrap-transport";
  await withInstallationCycle("B2-bootstrap", () =>
    bootstrapControls((stage) => {
      control = `B2-${stage}`;
    }),
  );
  await withInstallationCycle("B3-native-diagnostics", () =>
    nativeDiagnosticControls((stage) => {
      control = `B3-${stage}`;
    }),
  );
  await nativeControls((stage) => {
    control = `native-${stage}`;
  });
  await browserLifecycleControls((stage) => {
    control = `browser-lifecycle-${stage}`;
  });
  console.log("installed-boundary remaining controls: NOT PROVEN; see boundary README");
}

(async () => {
  control = "diagnostic-selector";
  const selection = diagnosticSelection(process.argv.slice(2));
  control = "host-admission";
  await (selection ? diagnose(selection) : run());
})().catch((error) => {
  const diagnostic = mediationDiagnostic(error);
  if (diagnostic) console.error(`installed-boundary mediation:${JSON.stringify(diagnostic)}`);
  console.error(`installed-boundary control ${control}: FAIL; raw output redacted`);
  process.exitCode = 1;
});
