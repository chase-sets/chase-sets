#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

register("./typescript-extension-loader.mjs", import.meta.url);

const [{ createFilesystemObjectStorage, createS3ObjectStorage }, { verifyObservationPack }] = await Promise.all([
  import("../infrastructure/object-storage/index.ts"),
  import("../bounded-contexts/catalog/features/source-observations/api/observation-pack.ts"),
]);

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runVerifyObservationPackCli(process.argv.slice(2), process.env, process.stdout);
}

export async function runVerifyObservationPackCli(argv, env, output) {
  try {
    const options = parseOptions(argv);
    const target =
      options.target === "local" ? await localTarget(options.packDir) : spaceTarget(options.manifestKey, env);
    const result = await verifyObservationPack({
      storage: target.storage,
      manifestKey: target.manifestKey,
      requireAccepted: options.requireAccepted,
      ...(target.listedRelativePaths ? { listedRelativePaths: target.listedRelativePaths } : {}),
    });
    writeSafeOutput(output, {
      command: "verify",
      status: result.valid ? "verified" : "blocked",
      posture: result.posture,
      replayEligible: result.replayEligible,
      counts: result.counts,
      diagnostics: result.diagnostics.map(({ code, severity, category }) => ({ code, severity, category })),
    });
    return result.valid ? 0 : 1;
  } catch {
    writeSafeOutput(output, {
      command: "verify",
      status: "blocked",
      posture: "unknown",
      replayEligible: false,
      counts: { entryChunks: 0, envelopes: 0, assets: 0, payloadBytes: 0, assetBytes: 0 },
      diagnostics: [{ code: "manifest-schema-invalid", severity: "error", category: "schema" }],
    });
    return 1;
  }
}

async function localTarget(packDir) {
  if (!packDir) {
    throw new Error("Local verification requires --pack-dir.");
  }
  const root = path.resolve(packDir);
  if (!(await stat(root)).isDirectory()) {
    throw new Error("Local verification target must be a directory.");
  }
  const listedRelativePaths = await listFiles(root);
  const candidates = [];
  for (const relativePath of listedRelativePaths) {
    if (!relativePath.toLowerCase().endsWith(".json")) {
      continue;
    }
    const bytes = await readFile(path.join(root, ...relativePath.split("/")));
    if (bytes.byteLength > 10 * 1024 * 1024) {
      continue;
    }
    try {
      const value = JSON.parse(bytes.toString("utf8"));
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.schemaVersion === "string" &&
        value.schemaVersion.startsWith("observation-pack-manifest-")
      ) {
        candidates.push(relativePath);
      }
    } catch {
      // Non-manifest JSON is validated only when referenced by the manifest.
    }
  }
  if (candidates.length !== 1) {
    throw new Error("Local verification requires exactly one structurally identified manifest.");
  }
  return {
    storage: createFilesystemObjectStorage({ rootDir: root, publicBaseUrl: "https://local.invalid/private" }),
    manifestKey: candidates[0],
    listedRelativePaths,
  };
}

function spaceTarget(manifestKey, env) {
  if (!manifestKey) {
    throw new Error("Space verification requires --manifest-key.");
  }
  const accessKeyId = requiredEnv(env, "SEED_PACKS_SPACES_ACCESS_ID");
  const secretAccessKey = requiredEnv(env, "SEED_PACKS_SPACES_SECRET_KEY");
  const endpoint = env.SEED_PACKS_SPACES_ENDPOINT?.trim() || "https://nyc3.digitaloceanspaces.com";
  const bucket = env.SEED_PACKS_SPACES_BUCKET?.trim() || "cs-dev-seed-packs";
  const region = env.SEED_PACKS_SPACES_REGION?.trim() || "nyc3";
  return {
    storage: createS3ObjectStorage({
      bucket,
      region,
      endpoint,
      accessKeyId,
      secretAccessKey,
      publicBaseUrl: `${endpoint.replace(/\/$/, "")}/${bucket}`,
    }),
    manifestKey,
  };
}

function parseOptions(argv) {
  const known = ["--target", "--pack-dir", "--manifest-key", "--require-accepted"];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    const name = argument.split("=", 1)[0] ?? argument;
    if (!known.includes(name)) {
      throw new Error("Verifier received an unsupported option.");
    }
    if (!argument.includes("=")) {
      index += 1;
      if (index >= argv.length || argv[index]?.startsWith("--")) {
        throw new Error("Verifier option is missing its value.");
      }
    }
  }
  const target = readOption(argv, "--target") ?? "local";
  if (target !== "local" && target !== "space") {
    throw new Error("Verifier target must be local or space.");
  }
  const requireAccepted = readOption(argv, "--require-accepted") ?? "false";
  if (requireAccepted !== "true" && requireAccepted !== "false") {
    throw new Error("--require-accepted must be true or false.");
  }
  return {
    target,
    packDir: readOption(argv, "--pack-dir"),
    manifestKey: readOption(argv, "--manifest-key"),
    requireAccepted: requireAccepted === "true",
  };
}

function readOption(argv, name) {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1).trim() || null;
  }
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1]?.trim() || null : null;
}

async function listFiles(root, current = "") {
  const directory = path.join(root, ...current.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      throw new Error("Verifier does not follow symbolic links.");
    }
    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error("Space verification credentials are not configured.");
  }
  return value;
}

function writeSafeOutput(output, value) {
  output.write(`${JSON.stringify(value)}\n`);
}
