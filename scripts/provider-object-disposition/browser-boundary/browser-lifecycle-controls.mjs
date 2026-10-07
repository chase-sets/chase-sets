import assert from "node:assert/strict";
import { assertBrowserAdmission } from "../test-window-browser.mjs";
import { absent, identities, launch, withConcurrentBrowser } from "./native-controls.mjs";
import { withInstallationCycle } from "./installation-cycle.mjs";

export function browserPipe(child) {
  let pending = Buffer.alloc(0);
  let sequence = 0;
  let failure;
  const requests = new Map();
  const events = new Map();
  const fail = () => {
    failure ??= new Error("synthetic-browser-pipe-refused");
    for (const entry of [...requests.values(), ...events.values()]) entry.reject(failure);
    requests.clear();
    events.clear();
  };
  child.once("close", fail);
  child.stdio[3].on("error", fail);
  child.stdio[4].on("error", fail);
  child.stdio[4].on("data", (chunk) => {
    if (failure) return;
    if (pending.length + chunk.length > 65536) return fail();
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(0)) !== -1) {
      let message;
      try {
        message = JSON.parse(pending.subarray(0, end));
      } catch {
        return fail();
      }
      pending = pending.subarray(end + 1);
      if (!message || typeof message !== "object") return fail();
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
      timer = setTimeout(fail, 5000);
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
  const { sourceDigest } = await assertBrowserAdmission();
  for (const mode of ["SIGKILL", "SIGTERM", "pipe-cancel", "renderer-crash"]) {
    stage(mode);
    await withInstallationCycle(`browser-${mode}`, () =>
      withConcurrentBrowser(sourceDigest, async (survives) => {
        const running = launch(sourceDigest, "browser");
        const pipe = browserPipe(running.child);
        let records = [];
        let primary;
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
            await pipe.request("Inspector.enable", {}, sessionId);
            const crashed = pipe.event("Inspector.targetCrashed");
            void pipe.request("Page.crash", {}, sessionId).catch(() => {});
            await crashed;
            running.child.stdio[3].end();
          } else if (mode === "pipe-cancel") running.child.stdio[3].end();
          else assert.equal(running.child.kill(mode), true);
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
        await survives();
        console.log(`installed-boundary control 9/14/16/20 browser-${mode} drain and concurrent survival: PASS`);
      }),
    );
  }
}
