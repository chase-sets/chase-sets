import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectLeafDiffPaths,
  deriveTypeScriptOwnerContexts,
  evaluateTypeScriptOwnerContexts,
  typeScriptOwnerContextArtifactPath,
  typeScriptOwnerContextPartitionPath,
  typeScriptOwnerContextSchemaPath,
} from "./typescript-owner-context-derivation.mjs";
import { acquireHeavySlot } from "../lib/heavy-slot.mjs";
import { repoRoot } from "../lib/repo.mjs";

export const lockfileBoundArtifactPaths = Object.freeze([typeScriptOwnerContextArtifactPath]);

export const regenerateLockfileBoundArtifactFailureCodes = Object.freeze({
  semanticMovement: "lockfile-bound-artifact-semantic-movement-refused",
});

export const regenerateLockfileBoundArtifactExitCodes = Object.freeze({
  success: 0,
  semanticMovement: 2,
});

export class RegenerateLockfileBoundArtifactsError extends Error {
  constructor(code, exitCode, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "RegenerateLockfileBoundArtifactsError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function collectScalarChanges(committed, derived, segments = [], changes = new Map()) {
  if (Array.isArray(committed) && Array.isArray(derived)) {
    if (committed.length !== derived.length) throw new Error("owner-context array shape changed during regeneration");
    committed.forEach((value, index) => collectScalarChanges(value, derived[index], [...segments, index], changes));
    return changes;
  }
  if (
    committed &&
    derived &&
    typeof committed === "object" &&
    typeof derived === "object" &&
    !Array.isArray(committed) &&
    !Array.isArray(derived)
  ) {
    const committedKeys = Object.keys(committed);
    const derivedKeys = Object.keys(derived);
    if (JSON.stringify(committedKeys) !== JSON.stringify(derivedKeys)) {
      throw new Error("owner-context object shape changed during regeneration");
    }
    for (const key of committedKeys) {
      collectScalarChanges(committed[key], derived[key], [...segments, key], changes);
    }
    return changes;
  }
  if (JSON.stringify(committed) !== JSON.stringify(derived)) {
    changes.set(JSON.stringify(segments), JSON.stringify(derived));
  }
  return changes;
}

function jsonScalarRanges(source) {
  const ranges = new Map();
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(source[index] ?? "")) index += 1;
  };
  const scanString = () => {
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index++] === '"') break;
    }
    return { start, end: index };
  };
  const scanValue = (segments) => {
    skipWhitespace();
    if (source[index] === "{") {
      index += 1;
      skipWhitespace();
      while (source[index] !== "}") {
        const keyRange = scanString();
        const key = JSON.parse(source.slice(keyRange.start, keyRange.end));
        skipWhitespace();
        if (source[index++] !== ":") throw new Error("invalid owner-context JSON object");
        scanValue([...segments, key]);
        skipWhitespace();
        if (source[index] === ",") {
          index += 1;
          skipWhitespace();
        } else if (source[index] !== "}") {
          throw new Error("invalid owner-context JSON object separator");
        }
      }
      index += 1;
      return;
    }
    if (source[index] === "[") {
      index += 1;
      skipWhitespace();
      let itemIndex = 0;
      while (source[index] !== "]") {
        scanValue([...segments, itemIndex]);
        itemIndex += 1;
        skipWhitespace();
        if (source[index] === ",") {
          index += 1;
          skipWhitespace();
        } else if (source[index] !== "]") {
          throw new Error("invalid owner-context JSON array separator");
        }
      }
      index += 1;
      return;
    }
    const start = index;
    if (source[index] === '"') scanString();
    else while (index < source.length && !/[\s,\]}]/.test(source[index])) index += 1;
    ranges.set(JSON.stringify(segments), { start, end: index });
  };
  scanValue([]);
  skipWhitespace();
  if (index !== source.length) throw new Error("unexpected bytes after owner-context JSON");
  return ranges;
}

export function formatOwnerContextArtifactBytes(committedBytes, committedArtifact, derivedArtifact) {
  const normalized = Buffer.from(committedBytes).toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const source = `${normalized.trimEnd()}\n`;
  const ranges = jsonScalarRanges(source);
  const changes = collectScalarChanges(committedArtifact, derivedArtifact);
  const replacements = [...changes].map(([key, replacement]) => {
    const range = ranges.get(key);
    if (!range) throw new Error(`owner-context JSON scalar is missing at ${key}`);
    return { ...range, replacement };
  });
  let output = source;
  for (const { start, end, replacement } of replacements.toSorted((left, right) => right.start - left.start)) {
    output = `${output.slice(0, start)}${replacement}${output.slice(end)}`;
  }
  return Buffer.from(output, "utf8");
}

function parseJson(bytes) {
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

function defaultReadBytes(rootDir, relativePath) {
  return readFileSync(path.join(rootDir, relativePath));
}

function defaultWriteBytes(rootDir, relativePath, bytes) {
  writeFileSync(path.join(rootDir, relativePath), bytes);
}

export async function buildLockfileBoundArtifactRegeneration({
  rootDir = repoRoot,
  lockfilePath = path.join(rootDir, "pnpm-lock.yaml"),
  deriveArtifact = deriveTypeScriptOwnerContexts,
  readBytes = (relativePath) => defaultReadBytes(rootDir, relativePath),
} = {}) {
  const committedOwnerBytes = Buffer.from(readBytes(typeScriptOwnerContextArtifactPath));
  const committedOwnerArtifact = parseJson(committedOwnerBytes);
  const partition = parseJson(readBytes(typeScriptOwnerContextPartitionPath));
  const ownerSchema = parseJson(readBytes(typeScriptOwnerContextSchemaPath));
  const evaluation = evaluateTypeScriptOwnerContexts({
    resolutionRoot: rootDir,
    lockfilePath,
    committedArtifact: committedOwnerArtifact,
    partition,
    schema: ownerSchema,
    comparedKeys: partition.semantic,
    deriveArtifact,
  });
  const ownerArtifact = evaluation.artifact;
  const movedOwnerLeaves = collectLeafDiffPaths(committedOwnerArtifact, ownerArtifact);
  const permittedProvenance = new Set(partition.provenance);
  const disallowedMovedLeaves = movedOwnerLeaves.filter((leaf) => !permittedProvenance.has(leaf));

  if (!evaluation.ok || disallowedMovedLeaves.length > 0) {
    const namedLeaves = [
      ...new Set([...disallowedMovedLeaves, ...evaluation.violations.map(({ key, code }) => key ?? code)]),
    ].sort();
    throw new RegenerateLockfileBoundArtifactsError(
      regenerateLockfileBoundArtifactFailureCodes.semanticMovement,
      regenerateLockfileBoundArtifactExitCodes.semanticMovement,
      `refusing to regenerate moved semantic or unclassified leaf(s): ${namedLeaves.join(", ")}. ` +
        "This command is limited to lockfile-bound provenance; SQL execution-surface and " +
        "authoritative-stream-read artifacts remain outside its scope.",
      { movedOwnerLeaves, disallowedMovedLeaves: namedLeaves, violations: evaluation.violations },
    );
  }

  const ownerBytes = formatOwnerContextArtifactBytes(committedOwnerBytes, committedOwnerArtifact, ownerArtifact);

  return {
    movedOwnerLeaves,
    artifacts: [
      {
        path: typeScriptOwnerContextArtifactPath,
        status: ownerBytes.equals(committedOwnerBytes) ? "unchanged" : "regenerated",
        bytes: ownerBytes,
      },
    ],
  };
}

export async function regenerateLockfileBoundArtifacts({
  rootDir = repoRoot,
  writeBytes = (relativePath, bytes) => defaultWriteBytes(rootDir, relativePath, bytes),
  ...buildOptions
} = {}) {
  const result = await buildLockfileBoundArtifactRegeneration({ rootDir, ...buildOptions });
  for (const artifact of result.artifacts) {
    if (artifact.status === "regenerated") writeBytes(artifact.path, artifact.bytes);
  }
  return result;
}

export function formatLockfileBoundArtifactRegeneration(result) {
  return (
    [
      `lockfile-bound-artifact-moved-leaves=${JSON.stringify(result.movedOwnerLeaves)}`,
      ...result.artifacts.map(({ path: artifactPath, status }) => `${artifactPath}: ${status}`),
    ].join("\n") + "\n"
  );
}

export async function runLockfileBoundArtifactRegenerationCli(options = {}, streams = {}) {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  try {
    const result = await regenerateLockfileBoundArtifacts(options);
    stdout.write(formatLockfileBoundArtifactRegeneration(result));
    return regenerateLockfileBoundArtifactExitCodes.success;
  } catch (error) {
    if (error instanceof RegenerateLockfileBoundArtifactsError) {
      stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  acquireHeavySlot("script-battery");
  process.exitCode = await runLockfileBoundArtifactRegenerationCli();
}
