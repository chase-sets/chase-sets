import assert from "node:assert/strict";
import { assertBrowserAdmission } from "../test-window-browser.mjs";
import { absent, identities, launch, withConcurrentBrowser } from "./native-controls.mjs";
import { withInstallationCycle } from "./installation-cycle.mjs";
import { withOwnershipStimulus } from "./ownership-controls.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { removalRefusal } from "./protocol.mjs";

const execute = promisify(execFile);
const cleanup =
  "/usr/local/lib/chase-sets-provider-window-input/scripts/provider-object-disposition/browser-boundary/ci-cleanup.sh";
const cleanupOptions = {
  env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
  timeout: 5000,
  maxBuffer: 4096,
  encoding: "buffer",
};

async function realOrphanRemoval(stage) {
  stage("13c-real-alone");
  await withInstallationCycle("13c-real-alone", async () => {
    const { sourceDigest } = await assertBrowserAdmission();
    const running = launch(sourceDigest, "browser");
    const pipe = browserPipe(running.child);
    let records = [];
    let primary;
    try {
      await pipe.request("Browser.getVersion");
      records = await identities(running.child.pid);
      assert.ok(records.length >= 3);
      assert.equal(running.child.kill("SIGKILL"), true);
      const removal = execute("/bin/bash", [cleanup], cleanupOptions);
      const [actual, { stdout, stderr }] = await Promise.all([running.result, removal]);
      assert.equal(actual.code, null);
      assert.equal(actual.signal, "SIGKILL");
      assert.equal(actual.stdout.length + actual.stderr.length, 0);
      const expected =
        "provider-boundary-cleanup-stage:remove-installation\n" +
        ["source-location", "remove-ownership", "remove-profile", "remove-target", "complete"]
          .map((name) => `provider-boundary-installer-stage:${name}\n`)
          .join("") +
        "provider-boundary-cleanup-installer-status:0\n" +
        ["remove-input", "verify-exact-names", "complete"]
          .map((name) => `provider-boundary-cleanup-stage:${name}\n`)
          .join("");
      assert.equal(stdout.equals(Buffer.from(expected)), true);
      assert.equal(stderr.length, 0);
      console.log(
        "installed-boundary control 13a/13c real kill/removal alone: exact native SIGKILL; installer=0; wrapper=0; complete exact bytes",
      );
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
  });
}

export function browserPipe(child) {
  let pending = Buffer.alloc(0);
  let sequence = 0;
  let failure;
  const requests = new Map();
  const events = new Map();
  const fail = (kind) => {
    failure ??= Object.assign(new Error("synthetic-browser-pipe-refused"), { kind });
    for (const entry of [...requests.values(), ...events.values()]) entry.reject(failure);
    requests.clear();
    events.clear();
  };
  child.once("close", () => fail("closed"));
  child.stdio[3].on("error", () => fail("stream"));
  child.stdio[4].on("error", () => fail("stream"));
  child.stdio[4].on("data", (chunk) => {
    if (failure) return;
    if (pending.length + chunk.length > 65536) return fail("overflow");
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(0)) !== -1) {
      let message;
      try {
        message = JSON.parse(pending.subarray(0, end));
      } catch {
        return fail("decode");
      }
      pending = pending.subarray(end + 1);
      if (!message || typeof message !== "object") return fail("decode");
      const entry = message.id ? requests.get(message.id) : events.get(message.method);
      if (!entry) continue;
      if (message.id) requests.delete(message.id);
      else events.delete(message.method);
      if (message.error) entry.reject(new Error("synthetic-browser-command-refused"));
      else entry.resolve(message.result ?? message.params);
    }
  });
  const wait = (collection, key) => {
    if (failure) return Promise.reject(failure);
    let timer;
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => fail("deadline"), 5000);
      collection.set(key, { resolve, reject });
    }).finally(() => clearTimeout(timer));
  };
  return {
    event: (method) => wait(events, method),
    request: (method, params = {}, sessionId) => {
      const id = ++sequence;
      const result = wait(requests, id);
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
      return result;
    },
  };
}

export async function browserLifecycleControls(stage) {
  await realOrphanRemoval(stage);
  const { sourceDigest } = await assertBrowserAdmission();
  for (const mode of ["SIGKILL", "SIGTERM", "pipe-cancel", "renderer-crash"]) {
    stage(mode);
    await withInstallationCycle(`browser-${mode}`, () =>
      withConcurrentBrowser(sourceDigest, async (survives) => {
        const running = launch(sourceDigest, "browser");
        const pipe = browserPipe(running.child);
        let records = [];
        let primary;
        let phase = "version";
        try {
          await pipe.request("Browser.getVersion");
          const { targetId } = await pipe.request("Target.createTarget", { url: "about:blank" });
          const { sessionId } = await pipe.request("Target.attachToTarget", { targetId, flatten: true });
          const evaluation = await pipe.request(
            "Runtime.evaluate",
            {
              expression: 'document.title = "SYNTHETIC_PRIVATE_LIFECYCLE_MARKER"',
              returnByValue: true,
            },
            sessionId,
          );
          assert.equal(evaluation.result.value, "SYNTHETIC_PRIVATE_LIFECYCLE_MARKER");
          records = await identities(running.child.pid);
          assert.ok(records.filter((record) => record.image === "launcher").length >= 2);
          assert.ok(records.some((record) => record.image === "chrome"));
          console.log(`installed-boundary browser-lifecycle-identities:${JSON.stringify({ mode, records })}`);
          if (mode === "renderer-crash") {
            phase = "discovery";
            await pipe.request("Target.setDiscoverTargets", { discover: true });
            phase = "inspector";
            await pipe.request("Inspector.enable", {}, sessionId);
            const crashed = Promise.race([pipe.event("Inspector.targetCrashed"), pipe.event("Target.targetCrashed")]);
            phase = "crash-event";
            void pipe.request("Page.crash", {}, sessionId).catch(() => {});
            await crashed;
            running.child.stdio[3].end();
          } else if (mode === "pipe-cancel") running.child.stdio[3].end();
          else if (mode === "SIGKILL") {
            const survivors = (await identities(process.pid)).filter(
              (record) => !records.some((owned) => owned.pid === record.pid),
            );
            const names = ["launcher.sha256", "files.sha256", "source.sha256"];
            const before = await Promise.all(
              names.map((name) => readFile(`/usr/local/lib/chase-sets-provider-window/${name}`)),
            );
            assert.equal(running.child.kill(mode), true);
            let failure;
            try {
              await execute("/bin/bash", [cleanup], cleanupOptions);
            } catch (error) {
              failure = error;
            }
            assert.equal(removalRefusal(failure, "remove-live-owner"), true);
            assert.deepEqual(
              await Promise.all(names.map((name) => readFile(`/usr/local/lib/chase-sets-provider-window/${name}`))),
              before,
            );
            const after = await identities(process.pid);
            for (const survivor of survivors)
              assert.ok(
                after.some(
                  (record) =>
                    record.pid === survivor.pid &&
                    record.start === survivor.start &&
                    record.image === survivor.image &&
                    record.parent === survivor.parent,
                ),
              );
            await assertBrowserAdmission();
            console.log(
              "installed-boundary control 13c real kill/removal concurrent: exact live-owner refusal; digests and full recorded survivor identities unchanged",
            );
          } else assert.equal(running.child.kill(mode), true);
          const actual = await running.result;
          const exact =
            actual.code === (mode === "SIGKILL" ? null : 143) &&
            actual.signal === (mode === "SIGKILL" ? "SIGKILL" : null) &&
            !actual.overflow;
          const markerAbsent = !Buffer.concat([actual.stdout, actual.stderr]).includes(
            "SYNTHETIC_PRIVATE_LIFECYCLE_MARKER",
          );
          console.log(
            `installed-boundary browser-lifecycle:${JSON.stringify({ mode, status: actual.code, signal: actual.signal, exact, markerAbsent, stdoutBytes: actual.stdout.length, stderrBytes: actual.stderr.length, redacted: true, truncated: actual.overflow })}`,
          );
          assert.equal(exact, true);
          assert.equal(markerAbsent, true);
        } catch (error) {
          console.error(
            `installed-boundary browser-lifecycle-failure:${JSON.stringify({ mode, phase, kind: ["closed", "stream", "overflow", "decode", "deadline"].includes(error.kind) ? error.kind : "assertion-or-command" })}`,
          );
          primary = error;
        } finally {
          if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
          const final = await running.result;
          if (primary)
            console.error(
              `installed-boundary browser-lifecycle-final:${JSON.stringify({ mode, status: final.code, signal: final.signal, stdoutBytes: final.stdout.length, stderrBytes: final.stderr.length, redacted: true, truncated: final.overflow })}`,
            );
          try {
            await absent(records);
          } catch (error) {
            primary ??= error;
          }
        }
        if (primary) throw primary;
        if (mode === "SIGKILL") {
          const old = records.find((record) => record.image === "launcher" && record.parent === running.child.pid);
          assert.ok(old);
          const constructed = await withOwnershipStimulus(
            "reuse",
            async () => {
              await absent([old]);
              await delay(2000);
            },
            old,
          );
          if (constructed)
            console.log(
              "installed-boundary control 11a native PID reuse: PASS; old record absent; synthetic survivor retired through pidfd",
            );
        }
        await survives();
        console.log(`installed-boundary control 9/14/16/20 browser-${mode} drain and concurrent survival: PASS`);
      }),
    );
  }
}
