#!/usr/bin/env node
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

export const AUTHORITY_ROOT = ".github/authority";
export const MANIFEST_PATH = "scripts/managed-postgres-authority-manifest.json";
const WORKFLOW_ROOT = ".github/workflows";
const GRANT_KEYS = ["file", "jobId", "stepAnchor", "secretName", "purpose"];
const DOCKER_KEYS = ["file", "jobId", "stepAnchor", "pathMapping"];
const PURPOSES = new Set([
  "alerting",
  "application-runtime",
  "delivery-board",
  "digitalocean-ops",
  "managed-postgres-boundary",
  "marketplace-ops",
  "release-evidence",
  "restore-drill-fork-ca",
  "spaces-evidence",
  "terraform-infra",
  "test-credentials",
]);

export async function generateManagedPostgresAuthority(repositoryRoot) {
  const { fragments, errors } = await readAuthoritySources(repositoryRoot);
  if (errors.length > 0) throw sourceValidationError(errors);
  const grants = fragments.flatMap(({ grants }) => grants).sort(compareGrants);
  const dockerConsumers = fragments.flatMap(({ dockerConsumers }) => dockerConsumers).sort(compareDockerConsumers);
  return dockerConsumers.length > 0 ? { schemaVersion: 1, grants, dockerConsumers } : { schemaVersion: 1, grants };
}

export async function validateManagedPostgresAuthoritySources(repositoryRoot, options = {}) {
  const root = resolve(repositoryRoot);
  const { fragments, errors, absent } = await readAuthoritySources(root);
  if (absent) return { valid: true, errors: [], fragments, skipped: true };
  if (errors.length > 0) return { valid: false, errors, fragments };
  const generated = buildManifest(fragments);
  if (options.checkManifest !== false) {
    let actual;
    try {
      actual = JSON.parse(await readFile(resolve(root, MANIFEST_PATH), "utf8"));
    } catch {
      return { valid: false, errors: ["canonical manifest is missing or invalid"], fragments, generated };
    }
    if (JSON.stringify(actual) !== JSON.stringify(generated)) {
      return {
        valid: false,
        errors: ["canonical manifest is stale; regenerate from authority fragments"],
        fragments,
        generated,
        actual,
      };
    }
  }
  return { valid: true, errors: [], fragments, generated };
}

export async function writeManagedPostgresAuthorityManifest(repositoryRoot, options = {}) {
  const root = resolve(repositoryRoot);
  const result = await validateManagedPostgresAuthoritySources(root, { checkManifest: false });
  if (!result.valid) throw sourceValidationError(result.errors);
  const output = `${JSON.stringify(result.generated, null, 2)}\n`;
  if (options.check) {
    let current = "";
    try {
      current = await readFile(resolve(root, MANIFEST_PATH), "utf8");
    } catch {
      return false;
    }
    return current === output;
  }
  await writeFile(resolve(root, MANIFEST_PATH), output, "utf8");
  return true;
}

async function readAuthoritySources(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const workflowInfo = await loadWorkflowInfo(root);
  const errors = [...workflowInfo.errors];
  const authorityRoot = resolve(root, AUTHORITY_ROOT);
  if (!(await statIfPresent(authorityRoot))) return { fragments: [], errors: [], absent: true };
  const files = await listFiles(authorityRoot);
  const fragments = [];
  const owners = new Map();
  for (const absolute of files) {
    const rel = toRepoPath(root, absolute);
    const parts = rel.slice(`${AUTHORITY_ROOT}/`.length).split("/");
    if (parts.length !== 2 || extname(parts[1]) !== ".json") {
      errors.push(`authority source must be <workflow-basename>/<jobId>.json: ${rel}`);
      continue;
    }
    const ownerStem = parts[0];
    const jobId = basename(parts[1], ".json");
    const workflow = workflowInfo.byStem.get(ownerStem);
    if (!workflow) {
      const folded = workflowInfo.byFoldedStem.get(ownerStem.toLowerCase());
      errors.push(folded ? `authority owner case mismatch: ${rel}` : `authority owner is not a workflow: ${rel}`);
      continue;
    }
    const ownerKey = `${workflow.file}\u0000${jobId}`;
    if (owners.has(ownerKey)) {
      errors.push(`duplicate authority owner: ${rel}`);
      continue;
    }
    owners.set(ownerKey, rel);
    let value;
    try {
      value = JSON.parse(await readFile(absolute, "utf8"));
    } catch {
      errors.push(`authority source is not valid JSON: ${rel}`);
      continue;
    }
    const grants = Array.isArray(value?.grants) ? value.grants : null;
    const dockerConsumers = value?.dockerConsumers === undefined ? [] : value.dockerConsumers;
    if (
      !plainObject(value) ||
      !onlyKeys(value, ["grants", "dockerConsumers"]) ||
      !grants ||
      !Array.isArray(dockerConsumers)
    ) {
      errors.push(`authority source shape is invalid: ${rel}`);
      continue;
    }
    if (!workflow.jobs.has(jobId)) errors.push(`authority owner job is orphaned: ${rel}`);
    for (const grant of grants) {
      validateRecord(grant, GRANT_KEYS, workflow.file, jobId, errors, rel);
      if (
        plainObject(grant) &&
        (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(grant.secretName ?? "") || !PURPOSES.has(grant.purpose))
      ) {
        errors.push(`authority grant value is invalid: ${rel}`);
      }
    }
    for (const consumer of dockerConsumers) validateRecord(consumer, DOCKER_KEYS, workflow.file, jobId, errors, rel);
    fragments.push({ grants, dockerConsumers });
  }
  return { fragments, errors };
}

async function loadWorkflowInfo(root) {
  const errors = [];
  const byStem = new Map();
  const byFoldedStem = new Map();
  const directory = resolve(root, WORKFLOW_ROOT);
  for (const absolute of await listFiles(directory)) {
    const relativeWorkflow = toRepoPath(root, absolute).slice(`${WORKFLOW_ROOT}/`.length);
    if (![".yml", ".yaml"].includes(extname(relativeWorkflow))) continue;
    const file = `${WORKFLOW_ROOT}/${relativeWorkflow}`;
    const stem = basename(relativeWorkflow, extname(relativeWorkflow));
    let value;
    try {
      const document = parseDocument(await readFile(absolute, "utf8"), { prettyErrors: false, uniqueKeys: true });
      if (document.errors.length > 0) throw new Error("yaml");
      value = document.toJS({ maxAliasCount: 100 });
    } catch {
      errors.push(`workflow cannot be parsed: ${file}`);
      continue;
    }
    const workflow = { file, jobs: new Set(Object.keys(value?.jobs ?? {})) };
    if (byStem.has(stem)) errors.push(`ambiguous workflow basename: ${stem}`);
    byStem.set(stem, workflow);
    const folded = stem.toLowerCase();
    const foldedEntries = byFoldedStem.get(folded) ?? [];
    foldedEntries.push(stem);
    byFoldedStem.set(folded, foldedEntries);
  }
  for (const [folded, stems] of byFoldedStem) {
    if (new Set(stems).size > 1) errors.push(`ambiguous workflow basename casing: ${folded}`);
  }
  return { byStem, byFoldedStem: new Map([...byFoldedStem].map(([key, stems]) => [key, stems[0]])), errors };
}

function validateRecord(value, keys, file, jobId, errors, source) {
  if (
    !plainObject(value) ||
    !onlyKeys(value, keys) ||
    !keys.every((key) => typeof value[key] === "string" && value[key].length > 0)
  ) {
    errors.push(`authority record shape is invalid: ${source}`);
    return;
  }
  if (value.file !== file || value.jobId !== jobId) errors.push(`authority record owner mismatch: ${source}`);
}

function buildManifest(fragments) {
  const grants = fragments.flatMap(({ grants }) => grants).sort(compareGrants);
  const dockerConsumers = fragments.flatMap(({ dockerConsumers }) => dockerConsumers).sort(compareDockerConsumers);
  return dockerConsumers.length ? { schemaVersion: 1, grants, dockerConsumers } : { schemaVersion: 1, grants };
}

function compareGrants(a, b) {
  return compareTuple(a, b, ["file", "jobId", "stepAnchor", "secretName", "purpose"]);
}
function compareDockerConsumers(a, b) {
  return compareTuple(a, b, ["file", "jobId", "stepAnchor", "pathMapping"]);
}
function compareTuple(a, b, keys) {
  for (const key of keys) {
    const left = a[key] ?? "";
    const right = b[key] ?? "";
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}
function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value, keys) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
function sourceValidationError(errors) {
  return new Error(`Managed Postgres authority source validation failed: ${errors.join("; ")}`);
}
async function readdirIfPresent(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
async function statIfPresent(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
async function listFiles(directory) {
  const entries = await readdirIfPresent(directory);
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
function toRepoPath(root, path) {
  return relative(root, path).split("\\").join("/");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--repository-root");
  const root = resolve(rootIndex >= 0 ? args[rootIndex + 1] : fileURLToPath(new URL("..", import.meta.url)));
  const check = args.includes("--check");
  writeManagedPostgresAuthorityManifest(root, { check })
    .then((ok) => {
      if (check && !ok) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
