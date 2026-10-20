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
// MSVC runtime argument splitting: whitespace separates arguments outside
// quotes, `""` inside quotes is one quote, and backslashes are literal unless
// they precede a quote. A quoted path holding spaces stays one argument.
function splitWindowsArguments(text) {
  const args = [];
  let current = null;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      let count = 1;
      while (text[index + count] === "\\") count += 1;
      const beforeQuote = text[index + count] === '"';
      current = (current ?? "") + "\\".repeat(beforeQuote ? Math.floor(count / 2) : count);
      index += count - 1;
      if (beforeQuote && count % 2 === 1) {
        current += '"';
        index += 1;
      }
    } else if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        current = (current ?? "") + '"';
        index += 1;
      } else {
        quoted = !quoted;
        current ??= "";
      }
    } else if (!quoted && (char === " " || char === "\t")) {
      if (current !== null) args.push(current);
      current = null;
    } else {
      current = (current ?? "") + char;
    }
  }
  if (current !== null) args.push(current);
  return args;
}

function parseWindowsArguments(text) {
  const args = text.match(/\/c\s+""[^\"]+"\s+(.*)"\s*$/i)?.[1]?.trim() ?? "";
  const separator = args.lastIndexOf(" -- ");
  if (separator < 0) return splitWindowsArguments(args);
  const command = args
    .slice(separator + 4)
    .replace(/^"|"$/g, "")
    .replaceAll('\\"', '"')
    .replaceAll('""', '"')
    .replaceAll("%%cd:~,%", "%");
  return [...splitWindowsArguments(args.slice(0, separator)), "--", command];
}

const argv = process.env.CHASE_SETS_FAKE_BWS_CMDLINE
  ? parseWindowsArguments(process.env.CHASE_SETS_FAKE_BWS_CMDLINE)
  : process.argv.slice(2);
const token = process.env.BWS_ACCESS_TOKEN;
const environmentNames = Object.keys(process.env);
const shellPath = argv[0] === "run" ? argv[4] : null;

function childEnvironment() {
  const listed = JSON.parse(config.list ?? "[]");
  const env = {};
  if (argv.includes("--no-inherit-env")) {
    for (const name of ["PATH", "SystemRoot", "ComSpec", "windir"]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
  } else {
    Object.assign(env, process.env);
    delete env.BWS_ACCESS_TOKEN;
  }
  for (const secret of listed) env[secret.key] = secret.value;
  return env;
}

function addBatchArg(parts, arg) {
  if (arg.includes("\r") || arg.includes("\n")) throw new Error("rust refuses CR/LF in batch args");
  let quote = arg.length === 0 || arg.endsWith("\\");
  for (const char of arg) {
    if (!/[A-Za-z0-9#$*+\-./:?@\\_]/.test(char) || /[\u0000-\u001f]/.test(char)) quote = true;
  }
  let output = quote ? '"' : "";
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1;
      output += char;
      continue;
    }
    if (char === '"') output += "\\".repeat(backslashes) + '"';
    else if (char === "%") output += "%%cd:~,";
    backslashes = 0;
    output += char;
  }
  if (quote) output += "\\".repeat(backslashes) + '"';
  parts.push(output);
}

function executeShell() {
  const command = argv[argv.length - 1];
  if (process.platform === "win32") {
    const parts = [`/e:ON`, `/v:OFF`, `/d`, `/c`, `""${shellPath}"`];
    addBatchArg(parts, "-c");
    addBatchArg(parts, command);
    parts[parts.length - 1] += '"';
    return spawnSync(process.env.ComSpec ?? "cmd.exe", [parts.join(" ")], {
      env: childEnvironment(),
      encoding: "buffer",
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }
  return spawnSync(shellPath, ["-c", command], {
    env: childEnvironment(),
    encoding: "buffer",
    shell: false,
    windowsHide: true,
  });
}

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
  if (config.executeShell) {
    const result = executeShell();
    if (result.error) process.stderr.write(String(result.error.message));
    else {
      process.stdout.write(result.stdout ?? Buffer.alloc(0));
      process.stderr.write(result.stderr ?? Buffer.alloc(0));
    }
  }
  await writeSegments(config.segments);
  process.stderr.write(
    'Error:\n   0: Received error message from server: [404 Not Found] {"message":"Resource not found."}\n',
  );
  process.exitCode = 1;
} else if (verb === "run") {
  if (config.executeShell) {
    const result = executeShell();
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
