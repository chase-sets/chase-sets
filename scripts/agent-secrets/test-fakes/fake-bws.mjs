// Fake bws for agent-secrets.test.mjs. It never contacts Bitwarden. Its
// behavior comes from fake-bws.json beside it, and it appends one record per
// call to fake-bws.log beside it. Records carry argv, names and a token digest,
// never an environment value.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(directory, "fake-bws.json"), "utf8"));
const argv = process.argv.slice(2);
const token = process.env.BWS_ACCESS_TOKEN;
const environmentNames = Object.keys(process.env);
const shellPath = argv[0] === "run" ? argv[4] : null;

let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {
  stdin = "";
}

appendFileSync(
  path.join(directory, "fake-bws.log"),
  `${JSON.stringify({
    marker: "chase-sets-fake-bws",
    argv,
    tokenSha256: typeof token === "string" ? createHash("sha256").update(token).digest("hex") : null,
    tokenEnvNames: token
      ? environmentNames.filter((name) => name !== "BWS_ACCESS_TOKEN" && process.env[name].includes(token))
      : [],
    bwEnvNames: environmentNames.filter((name) => /^BW_/i.test(name)),
    stdinBytes: Buffer.byteLength(stdin),
    stdinHasToken: Boolean(token) && stdin.includes(token),
    shellContent: config.executeShell && shellPath ? readFileSync(shellPath, "utf8") : null,
  })}\n`,
);

function writeBulk(bytes) {
  const chunk = 65536;
  for (let written = 0; written < bytes; written += chunk) {
    const size = Math.min(chunk, bytes - written);
    process.stdout.write("o".repeat(size));
    process.stderr.write("e".repeat(size));
  }
}

function encode(text, encoding = "utf8") {
  if (encoding === "utf8") return Buffer.from(text, "utf8");
  const little = Buffer.from(text, "utf16le");
  return encoding === "utf16le" ? little : little.swap16();
}

// Mutant output: {{TOKEN}} or {{TOKEN@start-end}} is the injected token (or a
// slice of it), so no test-written file carries the token. Each segment is
// flushed into its pipe before the next pause.
async function writeSegments(segments = []) {
  for (const { stream, text, encoding, pauseMs } of segments) {
    if (pauseMs) await sleep(pauseMs);
    const resolved = text.replace(/\{\{TOKEN(?:@(\d+)-(\d*))?\}\}/g, (_match, start, end) =>
      token.slice(Number(start ?? 0), end ? Number(end) : undefined),
    );
    const target = stream === "stderr" ? process.stderr : process.stdout;
    await new Promise((resolve) => target.write(encode(resolved, encoding), resolve));
  }
}

const [verb, noun] = argv;
if (verb === "secret" && noun === "list") {
  process.stderr.write(config.listStderr ?? "");
  process.stdout.write(config.list ?? "[]");
  process.exitCode = config.listExitCode ?? 0;
} else if (verb === "run" && config.runNotFound) {
  // bws 2.1.0 answers `run` against a readable project with zero secrets this way.
  await writeSegments(config.segments);
  process.stderr.write(
    'Error:\n   0: Received error message from server: [404 Not Found] {"message":"Resource not found."}\n',
  );
  process.exitCode = 1;
} else if (verb === "run") {
  if (config.executeShell) {
    const shell = argv[4];
    const command = argv[argv.length - 1];
    const shellArgs = ["-c", command];
    const result = process.platform === "win32"
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", shell, "-c", command], {
          env: process.env,
          encoding: "buffer",
          windowsHide: true,
        })
      : spawnSync(shell, shellArgs, {
          env: process.env,
          encoding: "buffer",
          shell: false,
          windowsHide: true,
        });
    if (result.error) {
      process.stderr.write(String(result.error.message));
      process.exitCode = 1;
    } else {
      process.stdout.write(result.stdout ?? Buffer.alloc(0));
      process.stderr.write(result.stderr ?? Buffer.alloc(0));
      process.exitCode = result.status ?? 1;
    }
    process.exit();
  }
  writeBulk(config.bulkBytes ?? 0);
  process.stdout.write(config.stdout ?? "");
  process.stderr.write(config.stderr ?? "");
  await writeSegments(config.segments);
  process.exitCode = config.exitCode ?? 0;
} else {
  process.stderr.write("fake bws: unsupported arguments\n");
  process.exitCode = 64;
}
