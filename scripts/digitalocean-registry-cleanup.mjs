import { execFile } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const DIGITALOCEAN_REGISTRY_CLEANUP_VERSION = "digitalocean-registry-cleanup/v1";

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(`${command} ${args.join(" ")} failed: ${message}`));
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

function collectImageTagsFromApp(app) {
  const spec = app.spec ?? app.Spec ?? {};
  const components = [
    ...(spec.services ?? spec.Services ?? []),
    ...(spec.workers ?? spec.Workers ?? []),
    ...(spec.jobs ?? spec.Jobs ?? []),
  ];

  return components
    .map((component) => component.image ?? component.Image)
    .filter(Boolean)
    .map((image) => image.tag ?? image.Tag)
    .filter((tag) => typeof tag === "string" && tag.length > 0);
}

export function selectTagsForDeletion(tags, options = {}) {
  return selectTagDeletionCandidates(tags, options).map((tag) => tag.name);
}

function selectTagDeletionCandidates(tags, options = {}) {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? 30;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const protectedTags = new Set(options.protectedTags ?? []);
  const protectedDigests = new Set(options.protectedDigests ?? []);
  const protectedPrefixes = options.protectedPrefixes ?? ["release-"];

  return tags
    .map(normalizeTag)
    .filter((tag) => tag.name)
    .filter((tag) => !protectedTags.has(tag.name))
    .filter((tag) => !tag.digest || !protectedDigests.has(tag.digest))
    .filter((tag) => !protectedPrefixes.some((prefix) => tag.name.startsWith(prefix)))
    .filter((tag) => parseDate(tag.updatedAt) < cutoff);
}

export async function fetchProtectedAppTags(appNames, options = {}) {
  if (appNames.length === 0) {
    return [];
  }

  const apps = await commandJson("doctl", ["apps", "list", "--output", "json"], options);
  const selectedApps = apps.filter((app) => {
    const spec = app.spec ?? app.Spec ?? {};
    const name = spec.name ?? spec.Name ?? app.name ?? app.Name;
    return appNames.includes(name);
  });

  const tags = [];
  for (const app of selectedApps) {
    const appId = app.id ?? app.ID;
    if (!appId) {
      tags.push(...collectImageTagsFromApp(app));
      continue;
    }

    const appDetails = await commandJson("doctl", ["apps", "get", appId, "--output", "json"], options);
    const detail = Array.isArray(appDetails) ? appDetails[0] : appDetails;
    tags.push(...collectImageTagsFromApp(detail ?? app));
  }

  return [...new Set(tags)];
}

function readRepeatedOption(argv, name) {
  const prefix = `${name}=`;
  return argv
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length))
    .filter(Boolean);
}

function readOption(argv, name, defaultValue) {
  const prefix = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? defaultValue;
}

export function parseDigitalOceanRegistryCleanupArgs(argv, env = process.env) {
  const dryRunInput = readOption(argv, "--dry-run", null);
  const envDryRun = env.DIGITALOCEAN_REGISTRY_CLEANUP_DRY_RUN;
  return {
    repository: readOption(argv, "--repository", env.PLATFORM_IMAGE_REPOSITORY ?? "chase-sets-platform"),
    retentionDays: Number.parseInt(
      readOption(argv, "--retention-days", env.DIGITALOCEAN_REGISTRY_CLEANUP_RETENTION_DAYS ?? "30"),
      10,
    ),
    dryRun: dryRunInput !== null ? true : parseBoolean(envDryRun ?? "false"),
    appNames: readRepeatedOption(argv, "--app-name"),
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
  const output = dependencies.commandOutput ?? commandOutput;
  const json = dependencies.commandJson ?? ((command, args) => commandJson(command, args, { commandOutput: output }));
  const errors = validateCleanupOptions(options);
  const baseRecord = {
    schemaVersion: DIGITALOCEAN_REGISTRY_CLEANUP_VERSION,
    checkedAt: options.checkedAt,
    mode: options.dryRun ? "dry-run" : "apply",
    repository: options.repository,
    retentionDays: options.retentionDays,
    protectedAppNames: options.appNames ?? [],
    protectedTags: [],
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

  const protectedTags = [
    ...(options.protectedTags ?? []),
    ...(await fetchProtectedAppTags(options.appNames ?? [], { commandOutput: output })),
  ];
  const tags = await json("doctl", ["registry", "repository", "list-tags", options.repository, "--output", "json"]);
  const selectedTags = selectTagDeletionCandidates(tags, {
    now: new Date(options.checkedAt),
    retentionDays: options.retentionDays,
    protectedTags,
  });
  const record = {
    ...baseRecord,
    protectedTags: [...new Set(protectedTags)].sort(),
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
  if (!isNonEmptyString(options.repository)) {
    errors.push("--repository is required.");
  }
  if (!Number.isFinite(options.retentionDays) || options.retentionDays < 0) {
    errors.push("--retention-days must be zero or greater.");
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
  const details = ["doctl registry cleanup command failed."];
  if (typeof error === "object" && error !== null) {
    if ("code" in error && error.code !== undefined) {
      details.push(`exit code: ${String(error.code)}`);
    }
    if ("stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
      details.push(`stderr: ${error.stderr.replace(/\s+/g, " ").trim().slice(0, 1000)}`);
    }
    if ("message" in error && typeof error.message === "string" && error.message.trim()) {
      details.push(`message: ${error.message.replace(/\s+/g, " ").trim().slice(0, 1000)}`);
    }
  }
  return details;
}

function parseBoolean(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error("DIGITALOCEAN_REGISTRY_CLEANUP_DRY_RUN must be true or false.");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "cleanup") {
    const result = await runDigitalOceanRegistryCleanup(parseDigitalOceanRegistryCleanupArgs(args));
    console.log(JSON.stringify(result.record, null, 2));
    return result.passesCleanupGate ? 0 : 1;
  }

  throw new Error(
    "Usage: node ./scripts/digitalocean-registry-cleanup.mjs cleanup [--repository=<name>] [--retention-days=<days>] [--app-name=<name>] [--protect-tag=<tag>] [--dry-run] [--out=<path>]",
  );
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
