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

async function installerControls(executable, stage) {
  const text = await readFile(
    "/usr/local/lib/chase-sets-provider-window/source/browser-boundary/install-ci.sh",
    "utf8",
  );
  const preambleEnd = text.indexOf("readonly target=");
  const begin = text.indexOf("direct_probe() {");
  const end = text.indexOf("# These are serialized");
  assert.ok(preambleEnd > 0 && begin > preambleEnd && end > begin);
  const { stdout: name } = await execute("/usr/bin/id", ["-un"], { env: environment, timeout: 1000, maxBuffer: 128 });
  const principal = name.trim();
  assert.match(principal, /^[a-z_][a-z0-9_-]{0,63}$/);
  const quotedExecutable = "'" + executable.replaceAll("'", "'\\''") + "'";
  for (const mode of ["stall-term", "stall-ignore", "wrong-stage"]) {
    stage(`installer-${mode}`);
    const deadline = mode.startsWith("stall-");
    const script =
      text.slice(0, preambleEnd) +
      text.slice(begin, end) +
      `\nmark synthetic-installer\nrefusal seed-deadline direct_probe -u '${principal}' -- ${quotedExecutable} ${mode}\n`;
    const execution = execute(
      "/usr/bin/sudo",
      ["-n", "/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "LC_ALL=C", "/bin/bash"],
      {
        env: environment,
        timeout: 7000,
        maxBuffer: 4096,
        encoding: "buffer",
      },
    );
    execution.child.stdin.end(script);
    let actual;
    try {
      actual = { ...(await execution), code: 0, signal: null };
    } catch (error) {
      actual = error;
    }
    const stdout = actual.stdout?.toString("ascii") ?? "";
    const closed =
      /^provider-boundary-installer-stage:synthetic-installer\nprovider-boundary-control:seed-deadline,status=(78|124|137),bytes=([0-9]{1,4}),redacted=true,truncated=false\nprovider-boundary-control-actual:seed-deadline,native-stage=(unknown|mapping-write)\n$/.exec(
        stdout,
      );
    const expected = `provider-boundary-installer-refused:negative-seed-deadline-${deadline ? "deadline" : "output"}\n`;
    const exact =
      actual.code === 1 &&
      !actual.signal &&
      Boolean(closed) &&
      actual.stderr?.equals(Buffer.from(expected)) &&
      (deadline
        ? ["124", "137"].includes(closed[1]) && closed[3] === "unknown"
        : closed[1] === "78" &&
          Number(closed[2]) === Buffer.byteLength("provider-boundary-refused:mapping-write\n") &&
          closed[3] === "mapping-write");
    console.log(
      `installed-boundary installer-control:${JSON.stringify({
        mode,
        installerStatus: Number.isInteger(actual.code) ? actual.code : null,
        wrappedStatus: closed ? Number(closed[1]) : null,
        exact,
        stdoutBytes: actual.stdout?.length ?? null,
        stderrBytes: actual.stderr?.length ?? null,
        redacted: true,
        truncated: actual.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      })}`,
    );
    assert.equal(exact, true);
  }
}

export async function nativeDiagnosticControls(stage) {
  const parent = resolve(process.env.RUNNER_TEMP);
  const directory = await mkdtemp(join(parent, "provider-boundary-diagnostics-"));
  assert.equal(resolve(directory).startsWith(parent + "/"), true);
  const executable = join(directory, "native-diagnostics");
  let primary;
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
    await installerControls(executable, stage);
  } catch (error) {
    primary = error;
  } finally {
    // Only this exclusive, resolved temporary directory is eligible for removal.
    assert.equal(resolve(directory).startsWith(parent + "/"), true);
    try {
      await rm(directory, { recursive: true });
    } catch (error) {
      primary ??= error;
    }
  }
  if (primary) throw primary;
}
