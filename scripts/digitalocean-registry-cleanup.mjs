import { execFile } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const DIGITALOCEAN_REGISTRY_CLEANUP_VERSION = "digitalocean-registry-cleanup/v1";
const DEFAULT_RETAIN_RECENT_SHA_TREE_TAGS = 25;
const SHA_TAG_PATTERN = /^[0-9a-f]{40}$/i;
const TREE_TAG_PATTERN = /^tree-[0-9a-f]{40}$/i;
const PROVIDER_MANAGED_GC_REFUSAL =
  "manual garbage collection is not available while automated garbage collection is enabled for this registry";

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(sanitizeCommandFailure(error, stdout, stderr));
        return;
      }

      resolve(stdout);
    });
  });
}

async function commandJson(command, args, options = {}) {
  const output = await (options.commandOutput ?? commandOutput)(command, args);
  return JSON.parse(output || "[]");
}

function parseDate(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeTag(tag) {
  return {
    name: tag.tag ?? tag.name ?? tag.Tag ?? tag.Name ?? "",
    digest: tag.digest ?? tag.manifest_digest ?? tag.ManifestDigest ?? "",
    updatedAt: tag.updated_at ?? tag.updatedAt ?? tag.UpdatedAt ?? tag.created_at ?? tag.CreatedAt ?? "",
  };
}

export function selectTagsForDeletion(tags, options = {}) {
  return selectTagDeletionCandidates(tags, options).map((tag) => tag.name);
}

function selectTagDeletionCandidates(tags, options = {}) {
  const protectedTags = new Set(options.protectedTags ?? []);
  const protectedDigests = new Set(options.protectedDigests ?? []);
  const protectedPrefixes = options.protectedPrefixes ?? ["release-"];
  const retainedRecentTags = new Set(
    selectRetainedRecentShaTreeTags(tags, options.retainRecentShaTreeTags ?? DEFAULT_RETAIN_RECENT_SHA_TREE_TAGS).map(
      (tag) => tag.name,
    ),
  );

  return tags
    .map(normalizeTag)
    .filter((tag) => tag.name)
    .filter((tag) => !protectedTags.has(tag.name))
    .filter((tag) => !tag.digest || !protectedDigests.has(tag.digest))
    .filter((tag) => !protectedPrefixes.some((prefix) => tag.name.startsWith(prefix)))
    .filter((tag) => !retainedRecentTags.has(tag.name));
}

function selectRetainedRecentShaTreeTags(tags, retainCount) {
  if (!Number.isFinite(retainCount) || retainCount <= 0) {
    return [];
  }

  return tags
    .map(normalizeTag)
    .filter((tag) => SHA_TAG_PATTERN.test(tag.name) || TREE_TAG_PATTERN.test(tag.name))
    .sort(
      (left, right) => parseDate(right.updatedAt) - parseDate(left.updatedAt) || right.name.localeCompare(left.name),
    )
    .slice(0, retainCount);
}

function resolveProtectedDigests(tags, protectedTags, protectedDigests) {
  const protectedTagSet = new Set(protectedTags);
  const digests = new Set(protectedDigests);

  for (const tag of tags.map(normalizeTag)) {
    if (protectedTagSet.has(tag.name) && tag.digest) {
      digests.add(tag.digest);
    }
  }

  return [...digests].sort();
}

function readRepeatedOption(argv, name) {
  const prefix = `${name}=`;
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      if (!value) throw new Error(`${name} requires a value.`);
      values.push(value);
      continue;
    }
    if (arg !== name) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    values.push(value);
    index += 1;
  }
  return values;
}

function readOption(argv, name, defaultValue) {
  const values = readRepeatedOption(argv, name);
  if (values.length > 1) throw new Error(`${name} may be provided only once.`);
  return values[0] ?? defaultValue;
}

export function parseDigitalOceanRegistryCleanupArgs(argv, env = process.env) {
  const dryRunInput = readOption(argv, "--dry-run", null);
  const requestedDryRunInput = env.DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN;
  return {
    repository: readOption(argv, "--repository", env.PLATFORM_IMAGE_REPOSITORY ?? "chase-sets-platform"),
    retentionDays: Number.parseInt(
      readOption(argv, "--retention-days", env.DIGITALOCEAN_REGISTRY_CLEANUP_RETENTION_DAYS ?? "30"),
      10,
    ),
    retainRecentShaTreeTags: Number.parseInt(
      readOption(
        argv,
        "--retain-recent-sha-tree-tags",
        env.DIGITALOCEAN_REGISTRY_CLEANUP_RETAIN_RECENT_SHA_TREE_TAGS ?? String(DEFAULT_RETAIN_RECENT_SHA_TREE_TAGS),
      ),
      10,
    ),
    dryRun: dryRunInput === null ? null : parseBoolean(dryRunInput, "--dry-run"),
    requestedDryRun:
      requestedDryRunInput === undefined
        ? null
        : parseBoolean(requestedDryRunInput, "DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN"),
    protectedTags: readRepeatedOption(argv, "--protect-tag"),
    outPath: readOption(argv, "--out", env.DIGITALOCEAN_REGISTRY_CLEANUP_OUT),
    checkedAt: readOption(argv, "--checked-at", new Date().toISOString()),
  };
}

export async function runDigitalOceanRegistryCleanup(options, dependencies = {}) {
  const result = await cleanupDigitalOceanRegistry(options, dependencies);
  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }
  return result;
}

export async function cleanupDigitalOceanRegistry(options, dependencies = {}) {
  options = {
    ...options,
    retentionDays: options.retentionDays ?? 30,
    retainRecentShaTreeTags: options.retainRecentShaTreeTags ?? DEFAULT_RETAIN_RECENT_SHA_TREE_TAGS,
  };
  const output = dependencies.commandOutput ?? commandOutput;
  const json = dependencies.commandJson ?? ((command, args) => commandJson(command, args, { commandOutput: output }));
  const errors = validateCleanupOptions(options);
  const baseRecord = {
    schemaVersion: DIGITALOCEAN_REGISTRY_CLEANUP_VERSION,
    checkedAt: options.checkedAt,
    mode: options.dryRun === true ? "dry-run" : options.dryRun === false ? "apply" : "invalid",
    requestedMode:
      options.requestedDryRun === true ? "dry-run" : options.requestedDryRun === false ? "apply" : "unknown",
    repository: options.repository,
    retentionDays: options.retentionDays,
    retainRecentShaTreeTags: options.retainRecentShaTreeTags,
    protectedTags: [],
    protectedDigests: [],
    retainedRecentShaTreeTags: [],
    selectedDeletionTags: [],
    deletedTags: [],
    failedTags: [],
    garbageCollection: {
      status: "skipped",
      reason: "not-evaluated",
    },
    result: "failure",
    errors,
  };

  if (errors.length > 0) {
    return { record: baseRecord, passesCleanupGate: false };
  }

  const protectedTags = options.protectedTags ?? [];
  let tags;
  try {
    tags = await json("doctl", ["registry", "repository", "list-tags", options.repository, "--output", "json"]);
  } catch (error) {
    baseRecord.errors = ["DigitalOcean registry tags could not be listed.", ...describeCommandFailure(error)];
    baseRecord.garbageCollection = {
      status: "skipped",
      reason: "registry-read-failed",
    };
    return { record: baseRecord, passesCleanupGate: false };
  }
  const protectedDigests = resolveProtectedDigests(tags, protectedTags, [...(options.protectedDigests ?? [])]);
  const retainedRecentShaTreeTags = selectRetainedRecentShaTreeTags(tags, options.retainRecentShaTreeTags);
  const selectedTags = selectTagDeletionCandidates(tags, {
    retainRecentShaTreeTags: options.retainRecentShaTreeTags,
    protectedTags,
    protectedDigests,
  });
  const record = {
    ...baseRecord,
    protectedTags: [...new Set(protectedTags)].sort(),
    protectedDigests,
    retainedRecentShaTreeTags: retainedRecentShaTreeTags.map(toTagSummary),
    selectedDeletionTags: selectedTags.map(toTagSummary),
    result: "success",
    errors: [],
  };

  if (options.dryRun) {
    record.garbageCollection = {
      status: "skipped",
      reason: "dry-run",
    };
    return { record, passesCleanupGate: true };
  }

  for (const tag of selectedTags) {
    try {
      await output("doctl", ["registry", "repository", "delete-tag", options.repository, tag.name, "--force"]);
      record.deletedTags.push(toTagSummary(tag));
    } catch (error) {
      record.failedTags.push({
        ...toTagSummary(tag),
        errors: describeCommandFailure(error),
      });
    }
  }

  if (record.failedTags.length > 0) {
    record.result = "failure";
    record.errors = ["One or more selected registry tags could not be deleted."];
    record.garbageCollection = {
      status: "skipped",
      reason: "delete-failed",
    };
    return { record, passesCleanupGate: false };
  }

  try {
    await output("doctl", ["registry", "garbage-collection", "start", "--force"]);
    record.garbageCollection = {
      status: "started",
      reason: selectedTags.length > 0 ? "cleanup-applied" : "no-deletions",
    };
  } catch (error) {
    if (isProviderManagedGarbageCollectionRefusal(error)) {
      record.garbageCollection = {
        status: "skipped",
        reason: "provider-managed",
      };
      return { record, passesCleanupGate: true };
    }

    record.result = "failure";
    record.errors = ["DigitalOcean registry garbage collection could not be started."];
    record.garbageCollection = {
      status: "failed",
      reason: "doctl-failed",
      errors: describeCommandFailure(error),
    };
    return { record, passesCleanupGate: false };
  }

  return { record, passesCleanupGate: true };
}

function validateCleanupOptions(options) {
  const errors = [];
  if (typeof options.dryRun !== "boolean") {
    errors.push("--dry-run=true|false is required.");
  }
  if (typeof options.requestedDryRun !== "boolean") {
    errors.push("DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN=true|false is required.");
  } else if (typeof options.dryRun === "boolean" && options.dryRun !== options.requestedDryRun) {
    errors.push(
      `Resolved cleanup mode ${options.dryRun ? "dry-run" : "apply"} does not match requested mode ${options.requestedDryRun ? "dry-run" : "apply"}.`,
    );
  }
  if (!isNonEmptyString(options.repository)) {
    errors.push("--repository is required.");
  }
  if (!Number.isFinite(options.retentionDays) || options.retentionDays < 0) {
    errors.push("--retention-days must be zero or greater.");
  }
  if (!Number.isFinite(options.retainRecentShaTreeTags) || options.retainRecentShaTreeTags < 0) {
    errors.push("--retain-recent-sha-tree-tags must be zero or greater.");
  }
  if (!Number.isFinite(Date.parse(options.checkedAt))) {
    errors.push("--checked-at must be an ISO-8601 timestamp.");
  }
  return errors;
}

function toTagSummary(tag) {
  return {
    name: tag.name,
    digest: tag.digest || null,
    updatedAt: tag.updatedAt || null,
  };
}

function describeCommandFailure(error) {
  const failure = classifyCommandFailure(error);
  const details = [`failure classification: ${failure.classification}`];
  if (failure.providerStatus !== null) details.push(`provider status: ${failure.providerStatus}`);
  return details;
}

function sanitizeCommandFailure(error, stdout, stderr) {
  const safeError = new Error("DigitalOcean registry command failed.");
  safeError.name = "DigitalOceanRegistryCommandError";
  safeError.commandFailure = classifyCommandFailure(error, stdout, stderr);
  return safeError;
}

export function classifyCommandFailure(error, stdout = "", stderr = "") {
  if (typeof error === "object" && error !== null && "commandFailure" in error) {
    return error.commandFailure;
  }

  const rawOutput = [stderr, stdout, typeof error?.stderr === "string" ? error.stderr : ""]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  const httpFailure = rawOutput.match(/(?:^|\s)(\d{3})\s+(.+)$/);
  const providerStatus = httpFailure ? Number.parseInt(httpFailure[1], 10) : null;
  const providerMessage = httpFailure?.[2]?.trim() ?? null;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  const classification =
    providerStatus !== null
      ? "provider-http"
      : error instanceof SyntaxError
        ? "invalid-response"
        : typeof code === "string"
          ? "transport"
          : typeof code === "number"
            ? "command-exit"
            : "unexpected";

  return {
    classification,
    providerStatus,
    providerManagedGarbageCollection: providerStatus === 412 && providerMessage === PROVIDER_MANAGED_GC_REFUSAL,
  };
}

function isProviderManagedGarbageCollectionRefusal(error) {
  return classifyCommandFailure(error).providerManagedGarbageCollection === true;
}

export function validateDigitalOceanRegistryCleanupRecord(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return ["cleanup record must be a JSON object"];
  }
  if (record.schemaVersion !== DIGITALOCEAN_REGISTRY_CLEANUP_VERSION) {
    errors.push(`schemaVersion must be ${DIGITALOCEAN_REGISTRY_CLEANUP_VERSION}`);
  }
  if (!isNonEmptyString(record.checkedAt) || !Number.isFinite(Date.parse(record.checkedAt))) {
    errors.push("checkedAt must be an ISO-8601 timestamp");
  }
  if (!["apply", "dry-run"].includes(record.mode)) errors.push("mode must be apply or dry-run");
  if (!["apply", "dry-run"].includes(record.requestedMode)) errors.push("requestedMode must be apply or dry-run");
  if (!["success", "failure", "deferred"].includes(record.result)) errors.push("result is invalid");
  if (!isNonEmptyString(record.repository)) errors.push("repository is required");
  for (const field of ["retentionDays", "retainRecentShaTreeTags"]) {
    if (!Number.isInteger(record[field]) || record[field] < 0) errors.push(`${field} must be a non-negative integer`);
  }
  for (const field of ["protectedTags", "protectedDigests", "errors"]) {
    if (!isStringArray(record[field])) errors.push(`${field} must be an array of strings`);
  }
  for (const field of ["retainedRecentShaTreeTags", "selectedDeletionTags", "deletedTags", "failedTags"]) {
    if (!Array.isArray(record[field])) {
      errors.push(`${field} must be an array`);
      continue;
    }
    record[field].forEach((tag, index) => {
      if (!isTagSummary(tag)) errors.push(`${field}[${index}] must be a cleanup tag summary`);
      if (field === "failedTags" && !isStringArray(tag?.errors)) {
        errors.push(`${field}[${index}].errors must be an array of strings`);
      }
    });
  }
  if (
    !record.garbageCollection ||
    typeof record.garbageCollection !== "object" ||
    Array.isArray(record.garbageCollection)
  ) {
    errors.push("garbageCollection must be an object");
  } else {
    if (!["failed", "skipped", "started"].includes(record.garbageCollection.status)) {
      errors.push("garbageCollection.status is invalid");
    }
    if (!isNonEmptyString(record.garbageCollection.reason)) errors.push("garbageCollection.reason is required");
    if (record.garbageCollection.errors !== undefined && !isStringArray(record.garbageCollection.errors)) {
      errors.push("garbageCollection.errors must be an array of strings");
    }
  }
  return errors;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => isNonEmptyString(entry));
}

function isTagSummary(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isNonEmptyString(value.name) &&
    (value.digest === null || isNonEmptyString(value.digest)) &&
    (value.updatedAt === null || (isNonEmptyString(value.updatedAt) && Number.isFinite(Date.parse(value.updatedAt))))
  );
}

function parseBoolean(value, name) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "cleanup") {
    const result = await runDigitalOceanRegistryCleanup(parseDigitalOceanRegistryCleanupArgs(args));
    console.log(
      `Registry cleanup terminal status: result=${result.record.result}; mode=${result.record.mode}; selected=${result.record.selectedDeletionTags.length}; deleted=${result.record.deletedTags.length}; failed=${result.record.failedTags.length}; garbage-collection=${result.record.garbageCollection.status}/${result.record.garbageCollection.reason}.`,
    );
    return result.passesCleanupGate ? 0 : 1;
  }

  throw new Error(
    "Usage: node ./scripts/digitalocean-registry-cleanup.mjs cleanup [--repository=<name>] [--retain-recent-sha-tree-tags=<count>] [--protect-tag=<tag>] --dry-run=<true|false> [--out=<path>|--out <path>]",
  );
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      console.error("Registry cleanup command failed before reaching a terminal status.");
      process.exitCode = 1;
    });
}
