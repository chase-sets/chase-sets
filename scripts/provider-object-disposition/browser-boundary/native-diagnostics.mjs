import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { TRANSITION, mediationDiagnostic, mediationFailure, nativeRefusal } from "./protocol.mjs";

const execute = promisify(execFile);
const marker = "SYNTHETIC_PRIVATE_NATIVE_BOUNDARY_MARKER";
const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYNTHETIC_BOUNDARY_MARKER: marker };

export async function nativeDiagnosticControls(stage) {
  const parent = resolve(process.env.RUNNER_TEMP);
  const directory = await mkdtemp(join(parent, "provider-boundary-diagnostics-"));
  assert.equal(resolve(directory).startsWith(parent + "/"), true);
  const executable = join(directory, "native-diagnostics");
  try {
    stage("compile");
    await execute(
      "/usr/bin/gcc",
      [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-static",
        fileURLToPath(new URL("native-diagnostics.c", import.meta.url)),
        "-o",
        executable,
      ],
      {
        env: environment,
        timeout: 5000,
        maxBuffer: 4096,
        encoding: "buffer",
      },
    );
    const cases = [
      ["allowlisted", 78, null, "", "provider-boundary-refused:seed-deadline\n", "seed-deadline"],
      ["wrong-stage", 78, null, "", "provider-boundary-refused:mapping-write\n", "mapping-write"],
      ["status-zero", 0, null, "", "provider-boundary-refused:seed-deadline\n", null],
      ["empty", 78, null, "", "", null],
      ["multiline", 78, null, "", "provider-boundary-refused:seed-deadline\nSYNTHETIC_UNEXPECTED_LINE\n", null],
      [
        "nested",
        78,
        null,
        TRANSITION,
        "provider-boundary-refused:seed-reap\nprovider-boundary-refused:nested-sandbox\n",
        "seed-reap",
      ],
      ["private-marker", 78, null, "", marker + "\n", null],
      ["handled-term", 143, null, "", "", null],
      ["signal-term", null, "SIGTERM", "", "", null],
      ["signal-kill", null, "SIGKILL", "", "", null],
    ];
    for (const [name, status, signal, stdout, stderr, native] of cases) {
      stage(name);
      let actual;
      try {
        actual = {
          ...(await execute(executable, [name], {
            env: environment,
            timeout: 1000,
            maxBuffer: 4096,
            encoding: "buffer",
          })),
          code: 0,
          signal: null,
        };
      } catch (error) {
        actual = error;
      }
      const exact =
        actual.code === status &&
        (actual.signal ?? null) === signal &&
        actual.stdout.equals(Buffer.from(stdout)) &&
        actual.stderr.equals(Buffer.from(stderr));
      const failure = mediationFailure("installed-boundary", actual);
      const diagnostic = mediationDiagnostic(failure);
      console.log(
        `installed-boundary native-emitter:${JSON.stringify({ name, expectedStatus: status, expectedSignal: signal, exact, ...diagnostic })}`,
      );
      assert.equal(exact, true);
      assert.equal(nativeRefusal(actual.stdout, actual.stderr, actual.code), native);
      assert.equal(diagnostic.nativeStage, native);
      assert.equal(failure.message.includes(marker), false);
      const expectedRefusal =
        actual.code === 78 &&
        actual.stdout.length === 0 &&
        actual.stderr.equals(Buffer.from("provider-boundary-refused:seed-deadline\n"));
      assert.equal(expectedRefusal, name === "allowlisted");
      console.log(`installed-boundary control B3-${name}: PASS`);
    }
    stage("overflow");
    let overflow;
    try {
      await execute(executable, ["overflow"], { env: environment, timeout: 1000, maxBuffer: 4096, encoding: "buffer" });
    } catch (error) {
      overflow = error;
    }
    assert.equal(overflow?.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    const diagnostic = mediationDiagnostic(mediationFailure("installed-boundary", overflow));
    assert.equal(diagnostic.truncated, true);
    assert.equal(diagnostic.complete, false);
    assert.equal(diagnostic.nativeStage, null);
    console.log(
      `installed-boundary native-emitter:${JSON.stringify({ name: "overflow", expectedStatus: null, exact: false, ...diagnostic })}`,
    );
    console.log("installed-boundary control B3-overflow-rejected: PASS");
    stage("partial-file");
    const partial = join(directory, "SYNTHETIC_PARTIAL");
    await writeFile(partial, marker, { flag: "wx", mode: 0o600 });
    assert.equal(await readFile(partial, "utf8"), marker);
    await rm(partial);
    assert.deepEqual(await readdir(directory), ["native-diagnostics"]);
    console.log("installed-boundary control 20 native-output/environment/partial-file redaction: PASS");
  } finally {
    // Only this exclusive, resolved temporary directory is eligible for removal.
    assert.equal(resolve(directory).startsWith(parent + "/"), true);
    await rm(directory, { recursive: true });
  }
}
