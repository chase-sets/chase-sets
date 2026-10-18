// Fake bws for agent-secrets.test.mjs. It never contacts Bitwarden. Its
// behavior comes from fake-bws.json beside it, and it appends one record per
// call to fake-bws.log beside it. Records carry argv, names and a token digest,
// never an environment value.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(directory, "fake-bws.json"), "utf8"));
const argv = process.argv.slice(2);
const token = process.env.BWS_ACCESS_TOKEN;
const environmentNames = Object.keys(process.env);

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

const [verb, noun] = argv;
if (verb === "secret" && noun === "list") {
  process.stderr.write(config.listStderr ?? "");
  process.stdout.write(config.list ?? "[]");
  process.exitCode = config.listExitCode ?? 0;
} else if (verb === "run" && config.runNotFound) {
  // bws 2.1.0 answers `run` against a readable project with zero secrets this way.
  process.stderr.write(
    'Error:\n   0: Received error message from server: [404 Not Found] {"message":"Resource not found."}\n',
  );
  process.exitCode = 1;
} else if (verb === "run") {
  writeBulk(config.bulkBytes ?? 0);
  process.stdout.write(config.stdout ?? "");
  process.stderr.write(config.stderr ?? "");
  process.exitCode = config.exitCode ?? 0;
} else {
  process.stderr.write("fake bws: unsupported arguments\n");
  process.exitCode = 64;
}
