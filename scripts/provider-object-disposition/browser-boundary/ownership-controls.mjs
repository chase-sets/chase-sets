import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const helper =
  "/usr/local/lib/chase-sets-provider-window-input/scripts/provider-object-disposition/browser-boundary/ownership-stimulus.py";
const env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };

export async function withOwnershipStimulus(mode, test) {
  assert.ok(["orphan", "foreign", "cap"].includes(mode));
  const child = spawn("/usr/bin/sudo", ["-n", "/usr/bin/python3", helper, mode], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let resolveReady;
  let rejectReady;
  let overflow = false;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.on("data", (chunk) => {
    if (stdout.length + chunk.length > 4096) {
      overflow = true;
      child.stdin.end();
      rejectReady(new Error("owner-stimulus-overflow"));
      return;
    }
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.includes(10)) {
      try {
        resolveReady(JSON.parse(stdout.subarray(0, stdout.indexOf(10))));
      } catch {
        rejectReady(new Error("owner-stimulus-invalid"));
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length + chunk.length > 4096) {
      overflow = true;
      child.stdin.end();
    } else stderr = Buffer.concat([stderr, chunk]);
  });
  const ended = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      rejectReady(error);
      reject(error);
    });
    child.once("close", (code, signal) => {
      rejectReady(new Error("owner-stimulus-ended"));
      resolve({ code, signal });
    });
  });
  let primary;
  let constructed = false;
  const deadline = setTimeout(() => {
    child.stdin.end();
    rejectReady(new Error("owner-stimulus-deadline"));
  }, 15000);
  try {
    const result = await ready;
    if (!result.constructed) {
      assert.equal(mode, "cap");
      assert.ok(["EAGAIN", "ENOMEM", "EMFILE"].includes(result.reason));
      console.log(`installed-boundary control 13g native cap: NOT CONSTRUCTED; ${JSON.stringify(result)}`);
    } else {
      constructed = true;
      assert.equal(result.mode, mode);
      assert.ok(Number.isSafeInteger(result.children) && result.children > 0 && result.children <= 4097);
      await test();
    }
  } catch (error) {
    primary = error;
  } finally {
    child.stdin.end();
    const status = await ended;
    clearTimeout(deadline);
    const exact =
      status.code === 0 &&
      status.signal === null &&
      !overflow &&
      stderr.length === 0 &&
      stdout.subarray(stdout.indexOf(10) + 1).equals(Buffer.from("provider-boundary-owner-stimulus:retired\n"));
    console.log(
      `installed-boundary ownership-stimulus:${JSON.stringify({ mode, constructed, expectedStatus: 0, status: status.code, signal: status.signal, exactRetirement: exact, stdoutBytes: stdout.length, stderrBytes: stderr.length, redacted: true, truncated: overflow })}`,
    );
    if (!exact) primary ??= new Error("owner-stimulus-retirement");
  }
  if (primary) throw primary;
  return constructed;
}
