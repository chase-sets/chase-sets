import { execFile } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const DIGITALOCEAN_TERRAFORM_STATE_SNAPSHOT_VERSION = "digitalocean-terraform-state-snapshot/v1";

export const DEFAULT_TERRAFORM_STATE_KEYS = Object.freeze([
  "landing/staging.tfstate",
  "landing/production.tfstate",
  "environment-dns/staging.tfstate",
  "catalog-assets/preview.tfstate",
  "catalog-assets/staging.tfstate",
  "catalog-assets/production.tfstate",
  "observability/shared.tfstate",
]);

export const DEFAULT_STATE_BUCKET = "chase-sets-terraform-state";
export const DEFAULT_SPACES_ENDPOINT = "https://nyc3.digitaloceanspaces.com";
export const DEFAULT_ARCHIVE_PREFIX = "state-archive";

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
  return JSON.parse(output || "{}");
}

export function archiveDateFromCheckedAt(checkedAt) {
  const timestamp = Date.parse(checkedAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error("--checked-at must be an ISO-8601 timestamp.");
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function archiveKeyForStateKey(stateKey, options = {}) {
  const archivePrefix = trimSlashes(options.archivePrefix ?? DEFAULT_ARCHIVE_PREFIX);
  const archiveDate = options.archiveDate ?? archiveDateFromCheckedAt(options.checkedAt);
  return `${archivePrefix}/${archiveDate}/${trimSlashes(stateKey)}`;
}

export function selectExpiredArchiveKeys(objects, options = {}) {
  const archivePrefix = trimSlashes(options.archivePrefix ?? DEFAULT_ARCHIVE_PREFIX);
  const now = new Date(options.checkedAt);
  const retentionDays = options.retentionDays ?? 30;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  return objects
    .map((object) => object.Key ?? object.key ?? "")
    .filter(Boolean)
    .filter((key) => key.startsWith(`${archivePrefix}/`))
    .filter((key) => {
      const match = key.match(new RegExp(`^${escapeRegExp(archivePrefix)}/(\\d{4}-\\d{2}-\\d{2})/`));
      if (!match) return false;
      const archivedAt = Date.parse(`${match[1]}T00:00:00.000Z`);
      return Number.isFinite(archivedAt) && archivedAt < cutoff;
    })
    .sort();
}

export function parseTerraformStateSnapshotArgs(argv, env = process.env) {
  return {
    bucket: readOption(argv, "--bucket", env.TERRAFORM_STATE_BUCKET ?? DEFAULT_STATE_BUCKET),
    endpointUrl: readOption(argv, "--endpoint-url", env.SPACES_ENDPOINT_URL ?? DEFAULT_SPACES_ENDPOINT),
    archivePrefix: readOption(argv, "--archive-prefix", env.TERRAFORM_STATE_ARCHIVE_PREFIX ?? DEFAULT_ARCHIVE_PREFIX),
    retentionDays: Number.parseInt(
      readOption(argv, "--retention-days", env.TERRAFORM_STATE_SNAPSHOT_RETENTION_DAYS ?? "30"),
      10,
    ),
    checkedAt: readOption(argv, "--checked-at", new Date().toISOString()),
    outPath: readOption(argv, "--out", env.TERRAFORM_STATE_SNAPSHOT_OUT),
    stateKeys: readRepeatedOption(argv, "--state-key"),
  };
}

export async function runTerraformStateSnapshot(options, dependencies = {}) {
  const result = await snapshotTerraformState(options, dependencies);
  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }
  return result;
}

export async function snapshotTerraformState(options, dependencies = {}) {
  const errors = validateSnapshotOptions(options);
  const stateKeys = (options.stateKeys?.length ? options.stateKeys : DEFAULT_TERRAFORM_STATE_KEYS).map(trimSlashes);
  const archiveDate = errors.length === 0 ? archiveDateFromCheckedAt(options.checkedAt) : null;
  const baseRecord = {
    schemaVersion: DIGITALOCEAN_TERRAFORM_STATE_SNAPSHOT_VERSION,
    checkedAt: options.checkedAt,
    bucket: options.bucket,
    endpointUrl: options.endpointUrl,
    archivePrefix: trimSlashes(options.archivePrefix ?? DEFAULT_ARCHIVE_PREFIX),
    archiveDate,
    retentionDays: options.retentionDays,
    stateKeys,
    snapshots: [],
    prunedArchiveKeys: [],
    result: "failure",
    errors,
  };

  if (errors.length > 0) {
    return { record: baseRecord, passesSnapshotGate: false };
  }

  const output = dependencies.commandOutput ?? commandOutput;
  const json = dependencies.commandJson ?? ((command, args) => commandJson(command, args, { commandOutput: output }));
  const aws = (args) => output("aws", [...args, "--endpoint-url", options.endpointUrl]);
  const awsJson = (args) => json("aws", [...args, "--endpoint-url", options.endpointUrl]);
  const record = { ...baseRecord, errors: [] };

  for (const stateKey of stateKeys) {
    const archiveKey = archiveKeyForStateKey(stateKey, {
      archivePrefix: record.archivePrefix,
      archiveDate,
    });

    try {
      const head = await awsJson(["s3api", "head-object", "--bucket", options.bucket, "--key", stateKey]);
      await aws([
        "s3api",
        "copy-object",
        "--bucket",
        options.bucket,
        "--key",
        archiveKey,
        "--copy-source",
        `/${options.bucket}/${stateKey}`,
        "--metadata-directive",
        "COPY",
      ]);
      record.snapshots.push({
        stateKey,
        archiveKey,
        sizeBytes: normalizeContentLength(head),
        lastModified: head.LastModified ?? head.lastModified ?? null,
        etag: stripQuotes(head.ETag ?? head.etag ?? null),
        status: "copied",
      });
    } catch (error) {
      record.snapshots.push({
        stateKey,
        archiveKey,
        sizeBytes: null,
        lastModified: null,
        etag: null,
        status: "failed",
        errors: describeCommandFailure(error),
      });
    }
  }

  try {
    const listed = await awsJson([
      "s3api",
      "list-objects-v2",
      "--bucket",
      options.bucket,
      "--prefix",
      `${record.archivePrefix}/`,
    ]);
    const expiredKeys = selectExpiredArchiveKeys(listed.Contents ?? listed.contents ?? [], {
      archivePrefix: record.archivePrefix,
      checkedAt: options.checkedAt,
      retentionDays: options.retentionDays,
    });

    for (const key of expiredKeys) {
      await aws(["s3api", "delete-object", "--bucket", options.bucket, "--key", key]);
      record.prunedArchiveKeys.push(key);
    }
  } catch (error) {
    record.errors.push("Terraform state archive retention pruning failed.");
    record.errors.push(...describeCommandFailure(error));
  }

  const failedSnapshots = record.snapshots.filter((snapshot) => snapshot.status !== "copied").length;
  if (failedSnapshots > 0) {
    record.result = "failure";
    record.errors.unshift(`${failedSnapshots} Terraform state object(s) could not be snapshotted.`);
    return { record, passesSnapshotGate: false };
  }

  record.result = record.errors.length > 0 ? "failure" : "success";
  return { record, passesSnapshotGate: record.errors.length === 0 };
}

function validateSnapshotOptions(options) {
  const errors = [];
  if (!isNonEmptyString(options.bucket)) {
    errors.push("--bucket is required.");
  }
  if (!isNonEmptyString(options.endpointUrl)) {
    errors.push("--endpoint-url is required.");
  }
  if (!isNonEmptyString(options.archivePrefix)) {
    errors.push("--archive-prefix is required.");
  }
  if (!Number.isFinite(options.retentionDays) || options.retentionDays < 0) {
    errors.push("--retention-days must be zero or greater.");
  }
  if (!Number.isFinite(Date.parse(options.checkedAt))) {
    errors.push("--checked-at must be an ISO-8601 timestamp.");
  }
  return errors;
}

function normalizeContentLength(head) {
  const value = head.ContentLength ?? head.contentLength ?? null;
  return Number.isFinite(value) ? value : null;
}

function describeCommandFailure(error) {
  const details = ["Terraform state snapshot command failed."];
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

function trimSlashes(value) {
  return String(value ?? "").replace(/^\/+|\/+$/g, "");
}

function stripQuotes(value) {
  return typeof value === "string" ? value.replace(/^"+|"+$/g, "") : value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "snapshot") {
    const result = await runTerraformStateSnapshot(parseTerraformStateSnapshotArgs(args));
    console.log(JSON.stringify(result.record, null, 2));
    return result.passesSnapshotGate ? 0 : 1;
  }

  throw new Error(
    "Usage: node ./scripts/digitalocean-terraform-state-snapshot.mjs snapshot [--bucket=<bucket>] [--endpoint-url=<url>] [--archive-prefix=<prefix>] [--retention-days=<days>] [--state-key=<key>] [--out=<path>]",
  );
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
