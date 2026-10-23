import { execFile, spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const DIGITALOCEAN_PREVIEW_CLEANUP_SWEEP_VERSION = "digitalocean-preview-cleanup-sweep/v2";
export const DIGITALOCEAN_PREVIEW_DATABASE_CLEANUP_VERSION = "digitalocean-preview-database-cleanup/v1";
export const DIGITALOCEAN_PREVIEW_DNS_VERSION = "digitalocean-preview-dns/v1";
export const DEFAULT_STATE_BUCKET = "chase-sets-terraform-state";
export const DEFAULT_SPACES_ENDPOINT = "https://nyc3.digitaloceanspaces.com";
export const DEFAULT_PREVIEW_STATE_PREFIX = "platform/previews/";
export const DIGITALOCEAN_PREVIEW_STATE_RETIREMENT_VERSION = "digitalocean-preview-state-retirement/v1";
export const PREVIEW_STATE_RETIREMENT_COMMAND_TIMEOUT_MS = 120 * 1000;
export const PREVIEW_DATABASE_TERRAFORM_ADDRESS = "digitalocean_database_cluster.postgres";
export const PREVIEW_DATABASE_DELETE_CONFIRMATION = "delete leaked preview database clusters";
export const PLATFORM_PREVIEW_IDLE_DRAFTS_VERSION = "platform-preview-idle-drafts/v1";
export const IDLE_DRAFT_MINIMUM_AGE_HOURS = 24;
export const IDLE_DRAFT_MAX_SELECTIONS = 10;
export const OPEN_PULL_REQUEST_PAGE_SIZE = 100;
export const OPEN_PULL_REQUEST_MAX_PAGES = 50;
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const HOUR_MS = 3_600_000;

// Per-preview DNS. Preview hostnames are single-label under
// preview.chasesets.com (`pr-<n>`, `pr-<n>-marketplace`, `pr-<n>-admin`), so
// ONE shared `*.preview.chasesets.com` wildcard record (applied once by the
// `apply-shared-dns` command below, part of the one-time bootstrap in
// docs/runbooks/doks-platform-operations.md) now covers every preview's every
// app host, replacing the old per-preview apex + `*.pr-<n>.preview` wildcard
// pair. `destroyPreviewDnsRecords`/`destroy-dns` and the `dnsRecordCandidates`
// detection in `discoverPreviewCleanupTargets` stay in place, unmodified, to
// drain any per-preview records created before this fix; no new PR ever
// creates one again.
export const PREVIEW_DNS_BASE_DOMAIN = "chasesets.com";
export const PREVIEW_DNS_ENVIRONMENT_LABEL = "preview";
export const PREVIEW_DNS_RECORD_TTL = 60;
export const PREVIEW_DNS_IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;
export const PREVIEW_SHARED_DNS_FQDN = `*.${PREVIEW_DNS_ENVIRONMENT_LABEL}.${PREVIEW_DNS_BASE_DOMAIN}`;
export const DISCOVERY_BUDGET_MS = 8 * 60 * 1000;
export const DISCOVERY_COMMAND_TIMEOUT_MS = 120 * 1000;
export const DISCOVERY_PULL_REQUEST_TIMEOUT_MS = 15 * 1000;
export const PREVIEW_CLEANUP_BATCH_SIZE = 32;
export const PREVIEW_CLEANUP_LOOKUP_WORKERS = 8;
const PREVIEW_CLEANUP_MAX_BATCHES = 256;

export function commandOutput(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = normalizeTimeout(options.timeout ?? options.timeoutMs);
    const useProcessGroup = process.platform !== "win32" && timeoutMs !== undefined;
    let settled = false;
    let timeoutId;
    let child;

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      callback(value);
    };

    const timeoutError = () => {
      const error = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms.`);
      error.code = "COMMAND_TIMEOUT";
      return error;
    };

    const terminate = () => {
      if (!child) {
        return;
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (process.platform === "win32" && child.pid) {
        try {
          spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          // The direct child kill below is the fallback when taskkill is unavailable.
        }
      } else if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") {
            child.kill("SIGKILL");
          }
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited while its streams were being destroyed.
      }
    };

    if (timeoutMs === undefined) {
      child = execFile(
        command,
        args,
        {
          cwd: options.cwd,
          env: options.env,
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            const message = stderr.trim() || stdout.trim() || error.message;
            finish(reject, new Error(`${command} ${args.join(" ")} failed: ${message}`));
            return;
          }

          finish(resolve, stdout);
        },
      );
    } else {
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputError;
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        detached: useProcessGroup,
      });
      const collect = (chunks, streamName) => (chunk) => {
        const bytes = Buffer.byteLength(chunk);
        if (streamName === "stdout") {
          stdoutBytes += bytes;
          if (stdoutBytes > 20 * 1024 * 1024) {
            outputError ??= new Error(`${command} ${args.join(" ")} failed: stdout maxBuffer exceeded.`);
            terminate();
            return;
          }
        } else {
          stderrBytes += bytes;
          if (stderrBytes > 20 * 1024 * 1024) {
            outputError ??= new Error(`${command} ${args.join(" ")} failed: stderr maxBuffer exceeded.`);
            terminate();
            return;
          }
        }
        chunks.push(chunk);
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", collect(stdout, "stdout"));
      child.stderr?.on("data", collect(stderr, "stderr"));
      child.once("error", (error) => {
        outputError ??= error;
      });
      child.once("close", (code, signal) => {
        if (outputError) {
          const message = outputError.message;
          finish(reject, new Error(message));
          return;
        }
        if (code !== 0) {
          const message = stderr.join("").trim() || stdout.join("").trim() || `process exited with ${signal ?? code}`;
          finish(reject, new Error(`${command} ${args.join(" ")} failed: ${message}`));
          return;
        }
        finish(resolve, stdout.join(""));
      });
    }

    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        const error = timeoutError();
        finish(reject, error);
        terminate();
      }, timeoutMs);
      timeoutId.unref?.();
    }
  });
}

async function commandJson(command, args, dependencies = {}, options = {}) {
  const output = dependencies.commandOutput
    ? await dependencies.commandOutput(command, args, options)
    : await commandOutput(command, args, { ...dependencies, ...options });
  return JSON.parse(output || "{}");
}

export function previewPrNumberFromStateKey(key, prefix = DEFAULT_PREVIEW_STATE_PREFIX) {
  const escapedPrefix = escapeRegExp(trimSlashes(prefix));
  const match = String(key ?? "").match(new RegExp(`^${escapedPrefix}/pr-(\\d+)\\.tfstate$`));
  return match ? Number.parseInt(match[1], 10) : null;
}

export function previewDatabaseClusterNameForPrNumber(prNumber) {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("Preview PR number must be a positive integer.");
  }
  return `chase-sets-pr-${prNumber}-postgres`;
}

// The Kubernetes preview path creates the preview's namespace with
// Helm (`--create-namespace`), never Terraform, so nothing in Terraform
// state ever names it. A merged/closed PR's namespace can therefore only be
// found by asking the live staging DOKS cluster which `chase-sets-pr-*`
// namespaces currently exist, independent of whatever Terraform state, live
// database clusters, or DNS records also do or don't exist for that PR.
export function previewPrNumberFromNamespaceName(name) {
  const match = String(name ?? "")
    .trim()
    .toLowerCase()
    .match(/^chase-sets-pr-(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

// Every PR deploy deletes and recreates its namespace ("Reset preview
// namespace" in platform-pr.yml), so `creationTimestamp` is the time of the
// preview's last deploy. The closed-PR sweep ignores it; idle-draft retirement
// reads it.
export function selectPreviewNamespaceTargets(namespaces) {
  const targetsByPr = new Map();

  for (const namespace of Array.isArray(namespaces) ? namespaces : []) {
    const name = typeof namespace === "string" ? namespace : (namespace?.metadata?.name ?? namespace?.name ?? "");
    const prNumber = previewPrNumberFromNamespaceName(name);
    if (prNumber && !targetsByPr.has(prNumber)) {
      targetsByPr.set(prNumber, {
        prNumber,
        namespace: `chase-sets-pr-${prNumber}`,
        creationTimestamp: namespace?.metadata?.creationTimestamp ?? null,
      });
    }
  }

  return [...targetsByPr.values()].sort((left, right) => left.prNumber - right.prNumber);
}

export function previewPrNumberFromDatabaseClusterName(name) {
  const normalized = String(name ?? "")
    .trim()
    .toLowerCase();
  const patterns = [
    /^chase-sets-pr-(\d+)-postgres$/,
    /^preview-pr-(\d+)(?:-|$)/,
    /^preview-(\d+)(?:-|$)/,
    /^pr-(\d+)-preview(?:-|$)/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }

  return null;
}

export function classifyDatabaseCluster(cluster) {
  const name = databaseClusterName(cluster);
  const normalizedName = name.toLowerCase();
  const tags = databaseClusterTags(cluster).map((tag) => tag.toLowerCase());
  const prNumber = previewPrNumberFromDatabaseCluster(cluster);

  if (normalizedName.startsWith("cs-prod-rp-")) {
    return { classification: "cs-prod-rp-*", prNumber: null };
  }

  if (prNumber || normalizedName.startsWith("preview-") || tags.includes("preview")) {
    return { classification: "preview-*", prNumber };
  }

  if (
    normalizedName === "chase-sets-staging-postgres" ||
    normalizedName === "staging-postgres" ||
    tags.includes("staging")
  ) {
    return { classification: "staging", prNumber: null };
  }

  if (
    normalizedName === "chase-sets-postgres" ||
    normalizedName === "chase-sets-production-postgres" ||
    normalizedName === "production-postgres" ||
    tags.includes("production")
  ) {
    return { classification: "production", prNumber: null };
  }

  return { classification: "unknown", prNumber: null };
}

export function previewPrNumberFromDatabaseCluster(cluster) {
  const fromName = previewPrNumberFromDatabaseClusterName(databaseClusterName(cluster));
  if (fromName) {
    return fromName;
  }

  for (const tag of databaseClusterTags(cluster)) {
    const normalized = tag.toLowerCase();
    const match = normalized.match(/^(?:pr|preview-pr|pull-request|github-pr)-(\d+)$/);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }

  return null;
}

export function selectPreviewStateTargets(objects, options = {}) {
  const prefix = trimSlashes(options.prefix ?? DEFAULT_PREVIEW_STATE_PREFIX);
  const targetsByPr = new Map();

  for (const object of objects) {
    const stateKey = object.Key ?? object.key ?? "";
    const prNumber = previewPrNumberFromStateKey(stateKey, prefix);
    if (!prNumber) {
      continue;
    }
    const existing = targetsByPr.get(prNumber);
    if (!existing || stateKey < existing.stateKey) {
      targetsByPr.set(prNumber, { prNumber, stateKey });
    }
  }

  return [...targetsByPr.values()].sort((left, right) => left.prNumber - right.prNumber);
}

export function selectPreviewDatabaseClusterTargets(clusters) {
  return normalizeDatabaseClusters(clusters)
    .map((cluster) => {
      const classification = classifyDatabaseCluster(cluster);
      if (classification.classification !== "preview-*" || !classification.prNumber) {
        return null;
      }

      return {
        prNumber: classification.prNumber,
        clusterId: databaseClusterId(cluster),
        clusterName: databaseClusterName(cluster),
        classification: classification.classification,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.prNumber - right.prNumber || left.clusterName.localeCompare(right.clusterName));
}

export function combinePreviewCleanupCandidates(stateTargets, databaseClusterTargets) {
  const byPr = new Map();
  const ensure = (prNumber) => {
    const existing = byPr.get(prNumber);
    if (existing) {
      return existing;
    }
    const candidate = { prNumber, stateKey: null, databaseClusters: [] };
    byPr.set(prNumber, candidate);
    return candidate;
  };

  for (const target of stateTargets) {
    ensure(target.prNumber).stateKey = target.stateKey;
  }

  for (const target of databaseClusterTargets) {
    const candidate = ensure(target.prNumber);
    candidate.databaseClusters.push({
      clusterId: target.clusterId,
      clusterName: target.clusterName,
    });
  }

  for (const candidate of byPr.values()) {
    candidate.databaseClusters.sort((left, right) => left.clusterName.localeCompare(right.clusterName));
  }

  return [...byPr.values()].sort((left, right) => left.prNumber - right.prNumber);
}

export function cleanupMatrixForTargets(targets, options = {}) {
  return {
    include: targets.map((target) => ({
      pr_number: target.prNumber,
      checkout_ref: options.checkoutRef,
      image_sha: options.imageSha,
      expected_database_cluster_name: previewDatabaseClusterNameForPrNumber(target.prNumber),
    })),
  };
}

export function cleanupBatchesForTargets(targets, batchSize = PREVIEW_CLEANUP_BATCH_SIZE) {
  const size =
    Number.isInteger(batchSize) && batchSize > 0
      ? Math.min(PREVIEW_CLEANUP_BATCH_SIZE, batchSize)
      : PREVIEW_CLEANUP_BATCH_SIZE;
  const orderedTargets = [...targets].sort((left, right) => left.prNumber - right.prNumber);
  const batches = [];
  for (let offset = 0; offset < orderedTargets.length; offset += size) {
    const batchTargets = orderedTargets.slice(offset, offset + size);
    batches.push({
      index: batches.length,
      firstPrNumber: batchTargets[0].prNumber,
      lastPrNumber: batchTargets.at(-1).prNumber,
      targets: batchTargets,
    });
  }
  return batches;
}

export function cleanupMatrixForBatches(batches, options = {}) {
  return {
    include: batches.map((batch) => ({
      batch_index: batch.index,
      batch_count: batches.length,
      checkout_ref: options.checkoutRef,
      image_sha: options.imageSha,
    })),
  };
}

export function previewStateKeyForPrNumber(prNumber, prefix = DEFAULT_PREVIEW_STATE_PREFIX) {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error("Preview PR number must be a positive integer.");
  }
  return `${trimSlashes(prefix)}/pr-${prNumber}.tfstate`;
}

// Retire only the exact matrix-derived state key after the caller has proved
// every cleanup operation for this PR succeeded. Terraform remains the
// authority for emptiness; object size and state JSON are deliberately never
// consulted. A missing, stale, unversioned, or non-empty state fails closed.
export async function retirePreviewTerraformState(options = {}, dependencies = {}) {
  const stateKey =
    Number.isSafeInteger(options.prNumber) && options.prNumber > 0
      ? previewStateKeyForPrNumber(options.prNumber, options.prefix)
      : null;
  const record = {
    schemaVersion: DIGITALOCEAN_PREVIEW_STATE_RETIREMENT_VERSION,
    checkedAt: options.checkedAt ?? new Date().toISOString(),
    prNumber: options.prNumber ?? null,
    bucket: options.bucket ?? DEFAULT_STATE_BUCKET,
    endpointUrl: options.endpointUrl ?? DEFAULT_SPACES_ENDPOINT,
    stateKey,
    terraformDirectory: options.terraformDirectory ?? "infrastructure/digitalocean/platform",
    cleanupSucceeded: options.cleanupSucceeded === true,
    stateList: { status: "not-run", empty: null, resourceCount: null },
    versioning: { status: "not-run" },
    headBeforeStateList: { status: "not-run", versionId: null },
    headBeforeDelete: { status: "not-run", versionId: null },
    delete: { status: "not-run" },
    outcome: "refused",
    result: "failure",
    errors: [],
  };
  const errors = validateRetireStateOptions(options);
  if (errors.length > 0) {
    record.errors.push(...errors);
    return record;
  }
  if (!record.cleanupSucceeded) {
    record.outcome = "skipped-cleanup-failure";
    record.errors.push("Preview cleanup did not succeed for this target; state was left untouched.");
    return record;
  }

  const timeoutMs = normalizeTimeout(dependencies.commandTimeoutMs ?? options.commandTimeoutMs) ?? PREVIEW_STATE_RETIREMENT_COMMAND_TIMEOUT_MS;
  const output = dependencies.commandOutput ?? commandOutput;
  const json = dependencies.commandJson ?? ((command, args) => commandJson(command, args, dependencies, { timeout: timeoutMs }));
  const aws = (args) => output("aws", [...args, "--endpoint-url", record.endpointUrl], { timeout: timeoutMs });
  const awsJson = (args) => json("aws", [...args, "--endpoint-url", record.endpointUrl]);
  const terraform = (args) => output("terraform", args, { timeout: timeoutMs });
  const backendArgs = [
    "-chdir=" + record.terraformDirectory,
    "init",
    "-reconfigure",
    `-backend-config=bucket=${record.bucket}`,
    `-backend-config=key=${record.stateKey}`,
    "-backend-config=region=us-east-1",
    `-backend-config=endpoints={s3=\"${record.endpointUrl}\"}`,
    "-backend-config=skip_credentials_validation=true",
    "-backend-config=skip_metadata_api_check=true",
    "-backend-config=skip_region_validation=true",
    "-backend-config=skip_requesting_account_id=true",
    "-backend-config=use_path_style=true",
    "-backend-config=use_lockfile=true",
  ];

  let before;
  try {
    before = await awsJson(["s3api", "head-object", "--bucket", record.bucket, "--key", record.stateKey]);
    record.headBeforeStateList = { status: "success", versionId: normalizeVersionId(before) };
    if (!record.headBeforeStateList.versionId) {
      throw new Error("head-object did not return a VersionId.");
    }
  } catch (error) {
    record.headBeforeStateList = { status: "failed", versionId: null };
    record.errors.push("Initial state-object head failed; state was left untouched.");
    return record;
  }

  try {
    await terraform(backendArgs);
  } catch (error) {
    record.stateList = { status: "backend-init-failed", empty: null, resourceCount: null };
    record.errors.push("Terraform backend initialization failed; state was left untouched.");
    return record;
  }

  try {
    const listed = await terraform(["-chdir=" + record.terraformDirectory, "state", "list", "-no-color"]);
    const resources = String(listed ?? "").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    record.stateList = { status: "success", empty: resources.length === 0, resourceCount: resources.length };
    if (resources.length > 0) {
      record.errors.push("Terraform state list is non-empty; state was left untouched.");
      return record;
    }
  } catch (error) {
    record.stateList = { status: "failed", empty: null, resourceCount: null };
    record.errors.push("Terraform state list failed; state was left untouched.");
    return record;
  }

  try {
    const versioning = await awsJson(["s3api", "get-bucket-versioning", "--bucket", record.bucket]);
    const status = String(versioning?.Status ?? versioning?.status ?? "");
    record.versioning = { status: status || "absent" };
    if (status !== "Enabled") {
      record.errors.push("State bucket versioning was not Enabled; state was left untouched.");
      return record;
    }
  } catch (error) {
    record.versioning = { status: "failed" };
    record.errors.push("State bucket versioning probe failed; state was left untouched.");
    return record;
  }

  try {
    const after = await awsJson(["s3api", "head-object", "--bucket", record.bucket, "--key", record.stateKey]);
    record.headBeforeDelete = { status: "success", versionId: normalizeVersionId(after) };
    if (record.headBeforeDelete.versionId !== record.headBeforeStateList.versionId) {
      record.errors.push("State object VersionId changed during retirement; state was left untouched.");
      return record;
    }
  } catch (error) {
    record.headBeforeDelete = { status: "failed", versionId: null };
    record.errors.push("Final state-object head failed; state was left untouched.");
    return record;
  }

  try {
    await aws(["s3api", "delete-object", "--bucket", record.bucket, "--key", record.stateKey]);
    record.delete = { status: "success" };
    record.outcome = "retired";
    record.result = "success";
  } catch (error) {
    record.delete = { status: "failed" };
    record.errors.push("State-object delete failed; state may still be present.");
  }
  return record;
}

function normalizeTimeout(value) {
  if (value === undefined) {
    return undefined;
  }
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs >= 1 ? Math.floor(timeoutMs) : undefined;
}

function normalizeVersionId(value) {
  const versionId = value?.VersionId ?? value?.versionId ?? null;
  return typeof versionId === "string" && versionId.trim() ? versionId.trim() : null;
}

function validateRetireStateOptions(options) {
  const errors = [];
  if (!Number.isSafeInteger(options.prNumber) || options.prNumber <= 0) {
    errors.push("--pr-number must be a positive integer.");
  }
  if (!isNonEmptyString(options.bucket ?? DEFAULT_STATE_BUCKET)) errors.push("--bucket is required.");
  if (!isNonEmptyString(options.endpointUrl ?? DEFAULT_SPACES_ENDPOINT)) errors.push("--endpoint-url is required.");
  if (!isNonEmptyString(options.terraformDirectory ?? "infrastructure/digitalocean/platform")) {
    errors.push("--terraform-directory is required.");
  }
  if (!Number.isFinite(Date.parse(options.checkedAt ?? new Date().toISOString()))) {
    errors.push("--checked-at must be an ISO timestamp.");
  }
  return errors;
}

function createClock(dependencies) {
  const candidate = dependencies.clock ?? dependencies.now;
  if (typeof candidate === "function") {
    return () => {
      const value = candidate();
      const timestamp = value instanceof Date ? value.getTime() : Number(value);
      return Number.isFinite(timestamp) ? timestamp : Date.now();
    };
  }
  if (candidate && typeof candidate.now === "function") {
    return () => {
      const value = candidate.now();
      const timestamp = value instanceof Date ? value.getTime() : Number(value);
      return Number.isFinite(timestamp) ? timestamp : Date.now();
    };
  }
  return () => Date.now();
}

function invokeWithTimeout(operation, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      const error = new Error(`${label} timed out after ${timeoutMs}ms.`);
      error.code = "DISCOVERY_TIMEOUT";
      reject(error);
    }, timeoutMs);

    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

function isTimeoutError(error) {
  return (
    error?.code === "COMMAND_TIMEOUT" ||
    error?.code === "DISCOVERY_TIMEOUT" ||
    error?.name === "TimeoutError" ||
    error?.name === "AbortError"
  );
}

function emptyStateObjectBytes() {
  return { under1KiB: 0, "1KiBTo64KiB": 0, "64KiBTo1MiB": 0, atLeast1MiB: 0 };
}

function stateObjectByteHistogram(objects) {
  const histogram = emptyStateObjectBytes();
  for (const object of Array.isArray(objects) ? objects : []) {
    const size = Number(object?.Size ?? object?.size ?? 0);
    if (!Number.isFinite(size) || size < 1024) {
      histogram.under1KiB += 1;
    } else if (size < 64 * 1024) {
      histogram["1KiBTo64KiB"] += 1;
    } else if (size < 1024 * 1024) {
      histogram["64KiBTo1MiB"] += 1;
    } else {
      histogram.atLeast1MiB += 1;
    }
  }
  return histogram;
}

function normalizeRecordList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.records)) {
    return value.records;
  }
  if (Array.isArray(value?.items)) {
    return value.items;
  }
  return [];
}

function normalizeNamespaceList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.items)) {
    return value.items;
  }
  throw new Error("kubectl namespace listing returned no items array.");
}

function countPreviewDnsZoneRecords(records, zone) {
  const normalizedZone = normalizeDnsName(zone);
  const previewZone = normalizeDnsName(`${PREVIEW_DNS_ENVIRONMENT_LABEL}.${PREVIEW_DNS_BASE_DOMAIN}`);
  return (Array.isArray(records) ? records : []).filter((record) => {
    const name = normalizeDnsName(record?.name ?? record?.Name);
    const fqdn = name === "@" || name === "" ? normalizedZone : `${name}.${normalizedZone}`;
    return normalizedZone === previewZone
      ? fqdn === normalizedZone || fqdn.endsWith(`.${normalizedZone}`)
      : fqdn === previewZone || fqdn.endsWith(`.${previewZone}`);
  }).length;
}

export async function discoverPreviewCleanupTargets(options = {}, dependencies = {}) {
  const now = createClock(dependencies);
  const startedAtMs = now();
  const discoveryBudgetMs =
    normalizeTimeout(
      dependencies.discoveryBudgetMs ?? dependencies.budgetMs ?? options.discoveryBudgetMs ?? options.budgetMs,
    ) ?? DISCOVERY_BUDGET_MS;
  const deadlineMs = startedAtMs + discoveryBudgetMs;
  const phases = ["state-list", "database-list", "dns-list", "namespace-list", "pr-lookups"].map((name) => ({
    name,
    startedAt: null,
    durationMs: null,
    count: null,
    error: null,
  }));
  const errors = validateDiscoverOptions(options);
  const baseRecord = {
    schemaVersion: DIGITALOCEAN_PREVIEW_CLEANUP_SWEEP_VERSION,
    checkedAt: options.checkedAt,
    bucket: options.bucket,
    endpointUrl: options.endpointUrl,
    prefix: trimSlashes(options.prefix),
    repository: options.repository,
    checkoutRef: options.checkoutRef,
    imageSha: options.imageSha,
    stateCandidates: [],
    databaseClusterCandidates: [],
    dnsRecordCandidates: [],
    namespaceCandidates: [],
    candidates: [],
    targets: [],
    stateObjectCount: 0,
    stateObjectBytes: emptyStateObjectBytes(),
    candidateCount: 0,
    closedTargetCount: 0,
    batchSize: PREVIEW_CLEANUP_BATCH_SIZE,
    batchCount: 0,
    batches: [],
    phases,
    result: "failure",
    warnings: [],
    errors,
  };
  if (errors.length > 0) {
    for (const phase of phases) {
      phase.error = "invalid-options";
    }
    return { record: baseRecord, matrix: { include: [] } };
  }

  const commandTimeoutMs =
    normalizeTimeout(
      dependencies.discoveryCommandTimeoutMs ?? dependencies.commandTimeoutMs ?? options.discoveryCommandTimeoutMs,
    ) ?? DISCOVERY_COMMAND_TIMEOUT_MS;
  const pullRequestTimeoutMs =
    normalizeTimeout(
      dependencies.discoveryPullRequestTimeoutMs ??
        dependencies.pullRequestTimeoutMs ??
        dependencies.lookupTimeoutMs ??
        options.discoveryPullRequestTimeoutMs,
    ) ?? DISCOVERY_PULL_REQUEST_TIMEOUT_MS;
  const remainingBudget = () => Math.max(0, deadlineMs - now());
  const markUnstarted = (reason) => {
    for (const phase of phases) {
      if (phase.startedAt === null) {
        phase.error = reason;
      }
    }
  };
  const startPhase = (phase) => {
    phase.startedAt = new Date(now()).toISOString();
    phase.durationMs = 0;
    phase.count = 0;
    phase.error = null;
  };
  const finishPhase = (phase, startedAt) => {
    phase.durationMs = Math.max(0, now() - startedAt);
  };
  const budgetCut = () => {
    record.targets = [];
    record.batchCount = 0;
    record.batches = [];
    record.errors.push("budget-exhausted");
    return { record, matrix: { include: [] } };
  };
  const bounded = async (label, operation, limitMs) => {
    const remaining = remainingBudget();
    if (remaining <= 0) {
      return { cut: true };
    }
    const timeoutMs = Math.min(limitMs, remaining);
    const deadlineBound = remaining <= limitMs;
    try {
      return { value: await invokeWithTimeout(() => operation(timeoutMs), timeoutMs, label), deadlineBound, timeoutMs };
    } catch (error) {
      return { error, deadlineBound, timeoutMs };
    }
  };
  const awsJson =
    typeof dependencies.awsJson === "function"
      ? (args) => dependencies.awsJson(args)
      : (args, timeoutMs) =>
          commandJson("aws", [...args, "--endpoint-url", options.endpointUrl], dependencies, { timeout: timeoutMs });
  const listDatabaseClusters =
    typeof dependencies.listDatabaseClusters === "function"
      ? () => dependencies.listDatabaseClusters()
      : (timeoutMs) =>
          commandJson("doctl", ["databases", "list", "--output", "json"], dependencies, { timeout: timeoutMs });
  const listDomains =
    typeof dependencies.listDomains === "function"
      ? () => dependencies.listDomains()
      : (timeoutMs) =>
          commandJson("doctl", ["compute", "domain", "list", "--output", "json"], dependencies, { timeout: timeoutMs });
  const listDomainRecords =
    typeof dependencies.listDomainRecords === "function"
      ? (zone) => dependencies.listDomainRecords(zone)
      : (zone, timeoutMs) =>
          commandJson("doctl", ["compute", "domain", "records", "list", zone, "--output", "json"], dependencies, {
            timeout: timeoutMs,
          });
  const listNamespaces =
    typeof dependencies.listNamespaces === "function"
      ? () => dependencies.listNamespaces()
      : (timeoutMs) =>
          commandJson("kubectl", ["get", "namespaces", "-o", "json"], dependencies, { timeout: timeoutMs });

  const record = { ...baseRecord, dnsRecordCandidates: [], namespaceCandidates: [], errors: [], warnings: [] };
  startPhase(phases[0]);
  const stateStartedAt = now();
  const stateResult = await bounded(
    "state-list",
    (timeoutMs) =>
      awsJson(["s3api", "list-objects-v2", "--bucket", options.bucket, "--prefix", `${record.prefix}/`], timeoutMs),
    commandTimeoutMs,
  );
  if (stateResult.cut || (stateResult.deadlineBound && stateResult.error && isTimeoutError(stateResult.error))) {
    phases[0].count = null;
    phases[0].error = "budget-exhausted";
    finishPhase(phases[0], stateStartedAt);
    markUnstarted("budget-exhausted");
    return budgetCut();
  }
  try {
    if (stateResult.error) {
      throw stateResult.error;
    }
    const listed = stateResult.value ?? {};
    const stateObjects = listed.Contents ?? listed.contents ?? [];
    record.stateObjectCount = Array.isArray(stateObjects) ? stateObjects.length : 0;
    record.stateObjectBytes = stateObjectByteHistogram(stateObjects);
    phases[0].count = record.stateObjectCount;
    record.stateCandidates = selectPreviewStateTargets(stateObjects, {
      prefix: record.prefix,
    });
  } catch (error) {
    phases[0].count = null;
    phases[0].error = describeError(error);
    finishPhase(phases[0], stateStartedAt);
    record.errors.push("Preview Terraform state listing failed.");
    record.errors.push(describeError(error));
    markUnstarted("skipped-after-state-list-failure");
    return { record, matrix: { include: [] } };
  }
  finishPhase(phases[0], stateStartedAt);

  startPhase(phases[1]);
  const databaseStartedAt = now();
  const databaseResult = await bounded(
    "database-list",
    (timeoutMs) => listDatabaseClusters(timeoutMs),
    commandTimeoutMs,
  );
  try {
    if (
      databaseResult.cut ||
      (databaseResult.deadlineBound && databaseResult.error && isTimeoutError(databaseResult.error))
    ) {
      throw Object.assign(new Error("budget-exhausted"), { code: "DISCOVERY_BUDGET" });
    }
    if (databaseResult.error) {
      throw databaseResult.error;
    }
    const databaseClusters = normalizeDatabaseClusters(databaseResult.value);
    phases[1].count = databaseClusters.length;
    record.databaseClusterCandidates = selectPreviewDatabaseClusterTargets(databaseClusters);
  } catch (error) {
    phases[1].count = null;
    phases[1].error = error.code === "DISCOVERY_BUDGET" ? "budget-exhausted" : describeError(error);
    finishPhase(phases[1], databaseStartedAt);
    if (error.code === "DISCOVERY_BUDGET") {
      markUnstarted("budget-exhausted");
      return budgetCut();
    }
    record.warnings.push("Preview database cluster listing failed; state-backed cleanup targets were still evaluated.");
    record.warnings.push(describeError(error));
  }
  finishPhase(phases[1], databaseStartedAt);

  // Leftover per-preview DNS records for closed PRs are drift, exactly like a
  // leaked managed cluster: the Kubernetes preview path now creates a
  // `pr-<n>.preview` apex + `*.pr-<n>.preview` wildcard, and a closed PR must
  // not leave either behind. Surface them as cleanup candidates so the destroy
  // matrix removes them even when no Terraform state or managed cluster remains.
  startPhase(phases[2]);
  const dnsStartedAt = now();
  try {
    const domainsResult = await bounded("dns-list", (timeoutMs) => listDomains(timeoutMs), commandTimeoutMs);
    if (
      domainsResult.cut ||
      (domainsResult.deadlineBound && domainsResult.error && isTimeoutError(domainsResult.error))
    ) {
      throw Object.assign(new Error("budget-exhausted"), { code: "DISCOVERY_BUDGET" });
    }
    if (domainsResult.error) {
      throw domainsResult.error;
    }
    const domains = normalizeDomainList(domainsResult.value);
    const zone = resolvePreviewDnsZone(
      domains,
      `${PREVIEW_DNS_ENVIRONMENT_LABEL}.${PREVIEW_DNS_BASE_DOMAIN}`,
      PREVIEW_DNS_BASE_DOMAIN,
    );
    const recordsResult = await bounded(
      "dns-list",
      (timeoutMs) => listDomainRecords(zone, timeoutMs),
      commandTimeoutMs,
    );
    if (
      recordsResult.cut ||
      (recordsResult.deadlineBound && recordsResult.error && isTimeoutError(recordsResult.error))
    ) {
      throw Object.assign(new Error("budget-exhausted"), { code: "DISCOVERY_BUDGET" });
    }
    if (recordsResult.error) {
      throw recordsResult.error;
    }
    const records = normalizeRecordList(recordsResult.value);
    record.dnsRecordCandidates = selectPreviewDnsRecordTargets(records, zone);
    phases[2].count = countPreviewDnsZoneRecords(records, zone);
  } catch (error) {
    phases[2].count = null;
    phases[2].error = error.code === "DISCOVERY_BUDGET" ? "budget-exhausted" : describeError(error);
    if (error.code === "DISCOVERY_BUDGET") {
      finishPhase(phases[2], dnsStartedAt);
      markUnstarted("budget-exhausted");
      return budgetCut();
    }
    record.warnings.push("Preview DNS record listing failed; state and cluster cleanup targets were still evaluated.");
    record.warnings.push(describeError(error));
  }
  finishPhase(phases[2], dnsStartedAt);

  // A closed PR's namespace is the leak this sweep exists to catch:
  // Terraform never created it, so it never appears in Terraform state, and
  // it can outlive its database cluster and DNS records once those are
  // cleaned up by an earlier partial run. Ask the live cluster directly.
  // Listing failure (e.g. no kubeconfig configured for this run) only
  // degrades this one candidate source to a warning; state/cluster/DNS-backed
  // reconciliation still proceeds.
  startPhase(phases[3]);
  const namespaceStartedAt = now();
  try {
    const namespacesResult = await bounded(
      "namespace-list",
      (timeoutMs) => listNamespaces(timeoutMs),
      commandTimeoutMs,
    );
    if (
      namespacesResult.cut ||
      (namespacesResult.deadlineBound && namespacesResult.error && isTimeoutError(namespacesResult.error))
    ) {
      throw Object.assign(new Error("budget-exhausted"), { code: "DISCOVERY_BUDGET" });
    }
    if (namespacesResult.error) {
      throw namespacesResult.error;
    }
    const namespaces = normalizeNamespaceList(namespacesResult.value);
    phases[3].count = namespaces.length;
    record.namespaceCandidates = selectPreviewNamespaceTargets(namespaces);
  } catch (error) {
    phases[3].count = null;
    phases[3].error = error.code === "DISCOVERY_BUDGET" ? "budget-exhausted" : describeError(error);
    if (error.code === "DISCOVERY_BUDGET") {
      finishPhase(phases[3], namespaceStartedAt);
      markUnstarted("budget-exhausted");
      return budgetCut();
    }
    record.warnings.push(
      "Preview namespace listing failed; state, cluster, and DNS cleanup targets were still evaluated.",
    );
    record.warnings.push(describeError(error));
  }
  finishPhase(phases[3], namespaceStartedAt);

  record.candidates = combinePreviewCleanupCandidates(record.stateCandidates, record.databaseClusterCandidates);

  for (const dnsCandidate of record.dnsRecordCandidates) {
    const existing = record.candidates.find((candidate) => candidate.prNumber === dnsCandidate.prNumber);
    if (existing) {
      existing.dnsRecords = dnsCandidate.records;
    } else {
      record.candidates.push({
        prNumber: dnsCandidate.prNumber,
        stateKey: null,
        databaseClusters: [],
        dnsRecords: dnsCandidate.records,
      });
    }
  }

  for (const namespaceCandidate of record.namespaceCandidates) {
    const existing = record.candidates.find((candidate) => candidate.prNumber === namespaceCandidate.prNumber);
    if (existing) {
      existing.namespace = namespaceCandidate.namespace;
    } else {
      record.candidates.push({
        prNumber: namespaceCandidate.prNumber,
        stateKey: null,
        databaseClusters: [],
        namespace: namespaceCandidate.namespace,
      });
    }
  }
  record.candidates.sort((left, right) => left.prNumber - right.prNumber);
  record.candidateCount = record.candidates.length;

  if (remainingBudget() <= 0) {
    phases[4].error = "budget-exhausted";
    markUnstarted("budget-exhausted");
    return budgetCut();
  }
  startPhase(phases[4]);
  const lookupStartedAt = now();
  let nextCandidateIndex = 0;
  let lookupsStarted = 0;
  let budgetExhausted = false;
  const lookupResults = new Array(record.candidates.length);
  const lookupCandidate = async (candidate, index) => {
    const remaining = remainingBudget();
    if (remaining <= 0) {
      budgetExhausted = true;
      return;
    }
    const timeoutMs = Math.min(pullRequestTimeoutMs, remaining);
    const deadlineBound = remaining <= pullRequestTimeoutMs;
    lookupsStarted += 1;
    try {
      const pullRequest =
        typeof dependencies.fetchPullRequest === "function"
          ? await invokeWithTimeout(
              () => dependencies.fetchPullRequest(candidate.prNumber),
              timeoutMs,
              `PR #${candidate.prNumber} lookup`,
            )
          : await invokeWithTimeout(
              () =>
                fetchGithubPullRequest({
                  repository: options.repository,
                  githubToken: options.githubToken,
                  prNumber: candidate.prNumber,
                  signal: AbortSignal.timeout(timeoutMs),
                }),
              timeoutMs,
              `PR #${candidate.prNumber} lookup`,
            );
      const state = String(pullRequest.state ?? "unknown").toLowerCase();
      lookupResults[index] = {
        ...candidate,
        pullRequestState: state,
        merged: Boolean(pullRequest.merged),
        selected: state === "closed",
      };
    } catch (error) {
      if (deadlineBound && isTimeoutError(error)) {
        budgetExhausted = true;
        return;
      }
      const detail =
        isTimeoutError(error) || error?.name === "AbortError"
          ? `timed out after ${timeoutMs}ms.`
          : describeError(error);
      lookupResults[index] = { error: `PR #${candidate.prNumber} lookup failed: ${detail}` };
    }
  };
  const lookupWorker = async () => {
    while (!budgetExhausted) {
      const index = nextCandidateIndex;
      if (index >= record.candidates.length) {
        return;
      }
      nextCandidateIndex += 1;
      await lookupCandidate(record.candidates[index], index);
    }
  };
  await Promise.all(Array.from({ length: PREVIEW_CLEANUP_LOOKUP_WORKERS }, () => lookupWorker()));
  phases[4].count = lookupsStarted;
  finishPhase(phases[4], lookupStartedAt);
  if (budgetExhausted) {
    phases[4].error = "budget-exhausted";
    markUnstarted("budget-exhausted");
    return budgetCut();
  }

  for (const result of lookupResults) {
    if (!result) {
      continue;
    }
    if (result.error) {
      phases[4].error ??= result.error.replace(/^PR #[0-9]+ lookup failed: /, "");
      record.errors.push(result.error);
      continue;
    }
    if (result.selected) {
      record.closedTargetCount += 1;
      record.targets.push(result);
    }
  }
  record.targets.sort((left, right) => left.prNumber - right.prNumber);
  record.batches = cleanupBatchesForTargets(record.targets, record.batchSize);
  record.batchCount = record.batches.length;
  if (record.batches.length > PREVIEW_CLEANUP_MAX_BATCHES) {
    record.result = "failure";
    record.errors.push("matrix-limit-exceeded");
    return { record, matrix: { include: [] } };
  }
  record.result =
    record.errors.length > 0
      ? "failure"
      : record.warnings.length > 0
        ? "warning"
        : record.targets.length > 0
          ? "success"
          : "empty";
  return {
    record,
    matrix: cleanupMatrixForBatches(record.batches, {
      checkoutRef: options.checkoutRef,
      imageSha: options.imageSha,
    }),
  };
}

// An idle draft is a live chase-sets-pr-<n> namespace whose PR is open
// and draft and whose namespace (recreated by every deploy) is at least 24h
// old. Retiring it loses only the browsable URL; the next push rebuilds it.
// A PR missing from the open listing is `not-open`, which is never selected,
// so a listing that drops an entry can only under-select.
function decideIdleDraftNamespace(target, openPullRequest, checkedAtMs) {
  const ageMs = checkedAtMs - Date.parse(target.creationTimestamp);
  const ageHours = Math.round((ageMs / HOUR_MS) * 10) / 10;
  if (!openPullRequest) {
    return { ageHours, decision: "not-open", reason: "PR is not open; the closed-PR sweep owns this namespace." };
  }
  if (!openPullRequest.draft) {
    return {
      ageHours,
      decision: "open-ready",
      reason: "PR is open and ready for review; its preview is never retired.",
    };
  }
  if (ageMs >= IDLE_DRAFT_MINIMUM_AGE_HOURS * HOUR_MS) {
    return {
      ageHours,
      decision: "idle-draft",
      reason: `Open draft; last deploy at least ${IDLE_DRAFT_MINIMUM_AGE_HOURS}h ago.`,
    };
  }
  return {
    ageHours,
    decision: "recent-draft",
    reason: `Open draft; last deploy under ${IDLE_DRAFT_MINIMUM_AGE_HOURS}h ago.`,
  };
}

export async function discoverIdleDraftPreviews(options, dependencies = {}) {
  const recheckPrNumber = options.prNumber ?? null;
  const record = {
    schemaVersion: PLATFORM_PREVIEW_IDLE_DRAFTS_VERSION,
    checkedAt: options.checkedAt,
    repository: options.repository,
    mode: recheckPrNumber === null ? "sweep" : "recheck",
    recheckPrNumber,
    minimumAgeHours: IDLE_DRAFT_MINIMUM_AGE_HOURS,
    maxSelections: IDLE_DRAFT_MAX_SELECTIONS,
    openPullRequestPages: 0,
    openPullRequestCount: 0,
    namespaces: [],
    selected: [],
    deferred: [],
    counts: null,
    recheck: null,
    result: "failure",
    errors: validateIdleDraftOptions(options),
  };
  const failed = () => ({ record, matrix: { include: [] } });
  if (record.errors.length > 0) {
    return failed();
  }

  const listNamespaces =
    dependencies.listNamespaces ??
    (() => commandJson("kubectl", ["get", "namespaces", "-o", "json", "--request-timeout=60s"], dependencies));
  const fetchOpenPullRequestPage =
    dependencies.fetchOpenPullRequestPage ??
    ((page) =>
      fetchGithubOpenPullRequestPage({ repository: options.repository, githubToken: options.githubToken, page }));

  let targets;
  try {
    const listed = await listNamespaces();
    const items = Array.isArray(listed) ? listed : listed?.items;
    if (!Array.isArray(items)) {
      throw new Error("kubectl namespace listing returned no items array.");
    }
    targets = selectPreviewNamespaceTargets(items);
    for (const target of targets) {
      if (!Number.isFinite(Date.parse(target.creationTimestamp ?? ""))) {
        throw new Error(`Namespace ${target.namespace} has no parseable creationTimestamp.`);
      }
    }
  } catch (error) {
    record.errors.push("Preview namespace listing failed; nothing was selected.");
    record.errors.push(describeError(error));
    return failed();
  }

  // Fail closed on any failed, malformed, or unbounded page: an incomplete
  // listing dispatches nothing.
  const openPullRequests = new Map();
  try {
    for (let page = 1; ; page += 1) {
      if (page > OPEN_PULL_REQUEST_MAX_PAGES) {
        throw new Error(`Open pull request listing exceeded ${OPEN_PULL_REQUEST_MAX_PAGES} pages.`);
      }
      const items = await fetchOpenPullRequestPage(page);
      if (!Array.isArray(items)) {
        throw new Error(`Open pull request page ${page} was not a JSON array.`);
      }
      for (const item of items) {
        if (!Number.isInteger(item?.number) || item?.state !== "open" || typeof item?.draft !== "boolean") {
          throw new Error(`Open pull request page ${page} returned an entry without number, open state, and draft.`);
        }
        openPullRequests.set(item.number, { number: item.number, draft: item.draft });
      }
      record.openPullRequestPages = page;
      if (items.length < OPEN_PULL_REQUEST_PAGE_SIZE) {
        break;
      }
    }
  } catch (error) {
    record.errors.push("Open pull request listing failed; nothing was selected.");
    record.errors.push(describeError(error));
    return failed();
  }
  record.openPullRequestCount = openPullRequests.size;

  const checkedAtMs = Date.parse(options.checkedAt);
  record.namespaces = targets.map((target) => ({
    ...target,
    ...decideIdleDraftNamespace(target, openPullRequests.get(target.prNumber), checkedAtMs),
  }));
  const summarize = ({ prNumber, namespace, creationTimestamp, ageHours }) => ({
    prNumber,
    namespace,
    creationTimestamp,
    ageHours,
  });

  if (record.mode === "recheck") {
    const entry = record.namespaces.find((namespace) => namespace.prNumber === recheckPrNumber);
    const selected = entry?.decision === "idle-draft";
    record.selected = selected ? [summarize(entry)] : [];
    record.recheck = {
      prNumber: recheckPrNumber,
      decision: entry?.decision ?? null,
      selected,
      reason: entry?.reason ?? `No live chase-sets-pr-${recheckPrNumber} namespace exists.`,
    };
  } else {
    const idleDrafts = record.namespaces
      .filter((namespace) => namespace.decision === "idle-draft")
      .sort(
        (left, right) =>
          Date.parse(left.creationTimestamp) - Date.parse(right.creationTimestamp) || left.prNumber - right.prNumber,
      )
      .map(summarize);
    record.selected = idleDrafts.slice(0, IDLE_DRAFT_MAX_SELECTIONS);
    record.deferred = idleDrafts.slice(IDLE_DRAFT_MAX_SELECTIONS);
  }

  const countDecision = (decision) => record.namespaces.filter((namespace) => namespace.decision === decision).length;
  record.counts = {
    namespaces: record.namespaces.length,
    idleDraft: countDecision("idle-draft"),
    recentDraft: countDecision("recent-draft"),
    openReady: countDecision("open-ready"),
    notOpen: countDecision("not-open"),
    selected: record.selected.length,
    deferred: record.deferred.length,
  };
  record.result = "success";
  return {
    record,
    matrix:
      record.mode === "recheck"
        ? cleanupMatrixForTargets(record.selected, { checkoutRef: options.checkoutRef, imageSha: options.imageSha })
        : { include: [] },
  };
}

export async function buildPreviewDatabaseClusterInventory(options, dependencies = {}) {
  const errors = [];
  if (!isNonEmptyString(options.repository)) {
    errors.push("--repo is required.");
  }
  if (!isNonEmptyString(options.checkedAt)) {
    errors.push("--checked-at is required.");
  }

  const record = {
    schemaVersion: DIGITALOCEAN_PREVIEW_DATABASE_CLEANUP_VERSION,
    checkedAt: options.checkedAt,
    repository: options.repository,
    mode: "inventory",
    clusters: [],
    result: "failure",
    warnings: [],
    errors,
  };
  if (errors.length > 0) {
    record.errors = errors;
    return record;
  }

  const listDatabaseClusters =
    dependencies.listDatabaseClusters ??
    (() => commandJson("doctl", ["databases", "list", "--output", "json"], dependencies));
  const fetchPullRequest =
    dependencies.fetchPullRequest ??
    ((prNumber) =>
      fetchGithubPullRequest({
        repository: options.repository,
        githubToken: options.githubToken,
        prNumber,
      }));

  let clusters;
  try {
    clusters = normalizeDatabaseClusters(await listDatabaseClusters());
  } catch (error) {
    record.errors.push("DigitalOcean database cluster listing failed.");
    record.errors.push(describeError(error));
    return record;
  }

  if (!isNonEmptyString(options.githubToken)) {
    record.warnings.push("GitHub token is unavailable; preview PR states were not resolved.");
  }

  for (const cluster of clusters) {
    const classification = classifyDatabaseCluster(cluster);
    const row = {
      clusterId: databaseClusterId(cluster),
      clusterName: databaseClusterName(cluster),
      classification: classification.classification,
      prNumber: classification.prNumber,
      pullRequestState: classification.prNumber ? "unknown" : "",
      leaked: false,
      previewManagedClusterViolation: classification.classification === "preview-*",
      conclusion: classification.classification === "preview-*" ? "preview-managed-cluster-violation" : "retained",
    };

    if (
      classification.classification === "preview-*" &&
      classification.prNumber &&
      isNonEmptyString(options.githubToken)
    ) {
      try {
        const pullRequest = await fetchPullRequest(classification.prNumber);
        row.pullRequestState = pullRequestStateLabel(pullRequest);
        row.leaked = row.pullRequestState === "closed" || row.pullRequestState === "merged";
        row.conclusion = row.leaked ? "leaked-preview-managed-cluster-violation" : "preview-managed-cluster-violation";
      } catch (error) {
        record.warnings.push(`PR #${classification.prNumber} lookup failed: ${describeError(error)}`);
      }
    }

    record.clusters.push(row);
  }

  record.clusters.sort(
    (left, right) =>
      left.classification.localeCompare(right.classification) || left.clusterName.localeCompare(right.clusterName),
  );
  if (record.clusters.some((cluster) => cluster.previewManagedClusterViolation)) {
    record.warnings.push(
      "Preview managed database clusters are forbidden; PR previews must use in-cluster Postgres in their Kubernetes namespace.",
    );
  }
  record.result = record.errors.length > 0 ? "failure" : record.warnings.length > 0 ? "warning" : "success";
  return record;
}

export async function cleanupLeakedPreviewDatabaseClusters(options, dependencies = {}) {
  const inventory = await buildPreviewDatabaseClusterInventory(options, dependencies);
  const record = {
    ...inventory,
    mode: options.delete ? "delete" : "dry-run",
    selectedDeletionClusters: [],
    deletedClusters: [],
    failedClusters: [],
  };
  if (inventory.result === "failure") {
    return record;
  }

  record.selectedDeletionClusters = inventory.clusters.filter((cluster) => cluster.leaked);
  if (!options.delete) {
    record.result = inventory.result;
    return record;
  }

  if (options.confirm !== PREVIEW_DATABASE_DELETE_CONFIRMATION) {
    record.errors.push(`Delete mode requires --confirm "${PREVIEW_DATABASE_DELETE_CONFIRMATION}".`);
    record.result = "failure";
    return record;
  }

  const deleteDatabaseCluster =
    dependencies.deleteDatabaseCluster ??
    ((cluster) => commandOutput("doctl", ["databases", "delete", cluster.clusterId, "--force"], dependencies));

  for (const cluster of record.selectedDeletionClusters) {
    if (!isNonEmptyString(cluster.clusterId)) {
      record.failedClusters.push({ ...cluster, error: "cluster-id-unavailable" });
      continue;
    }

    try {
      await deleteDatabaseCluster(cluster);
      record.deletedClusters.push(cluster);
    } catch (error) {
      record.failedClusters.push({ ...cluster, error: describeError(error) });
    }
  }

  record.result = record.failedClusters.length > 0 ? "failure" : inventory.warnings.length > 0 ? "warning" : "success";
  return record;
}

export async function importPreviewDatabaseClusterIntoTerraformState(options, dependencies = {}) {
  const prNumber = Number.parseInt(String(options.prNumber ?? ""), 10);
  const terraformDirectory = options.terraformDirectory ?? "infrastructure/digitalocean/platform";
  const terraformAddress = options.terraformAddress ?? PREVIEW_DATABASE_TERRAFORM_ADDRESS;
  const expectedClusterName =
    options.clusterName ?? (Number.isInteger(prNumber) ? previewDatabaseClusterNameForPrNumber(prNumber) : "");
  const record = {
    schemaVersion: DIGITALOCEAN_PREVIEW_DATABASE_CLEANUP_VERSION,
    checkedAt: options.checkedAt,
    mode: "terraform-import",
    prNumber,
    expectedClusterName,
    terraformDirectory,
    terraformAddress,
    selectedCluster: null,
    action: "not-evaluated",
    result: "failure",
    warnings: [],
    errors: [],
  };

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    record.errors.push("--pr-number must be a positive integer.");
  }
  if (!isNonEmptyString(terraformDirectory)) {
    record.errors.push("--terraform-directory is required.");
  }
  if (!isNonEmptyString(terraformAddress)) {
    record.errors.push("--terraform-address is required.");
  }
  if (record.errors.length > 0) {
    return record;
  }

  const listDatabaseClusters =
    dependencies.listDatabaseClusters ??
    (() => commandJson("doctl", ["databases", "list", "--output", "json"], dependencies));
  const output = dependencies.commandOutput ?? commandOutput;

  let matchingClusters;
  try {
    matchingClusters = selectPreviewDatabaseClusterTargets(await listDatabaseClusters()).filter(
      (cluster) => cluster.prNumber === prNumber,
    );
  } catch (error) {
    record.errors.push("Preview database cluster listing failed.");
    record.errors.push(describeError(error));
    return record;
  }

  const exactMatch = matchingClusters.find((cluster) => cluster.clusterName === expectedClusterName);
  if (!exactMatch && matchingClusters.length > 1) {
    record.errors.push(
      `Multiple preview database clusters match PR #${prNumber}; refusing to import one Terraform address ambiguously.`,
    );
    return record;
  }

  const selectedCluster = exactMatch ?? matchingClusters[0];
  if (!selectedCluster) {
    record.action = "skipped";
    record.result = "success";
    record.warnings.push(`No live preview database cluster matched PR #${prNumber}.`);
    return record;
  }
  record.selectedCluster = selectedCluster;

  let stateList = "";
  try {
    stateList = await output("terraform", [`-chdir=${terraformDirectory}`, "state", "list"]);
  } catch (error) {
    record.warnings.push(`Terraform state list failed; import will still be attempted: ${describeError(error)}`);
  }

  if (stateList.split(/\r?\n/).includes(terraformAddress)) {
    record.action = "already-managed";
    record.result = "success";
    return record;
  }

  if (!isNonEmptyString(selectedCluster.clusterId)) {
    record.errors.push(`Preview database cluster ${selectedCluster.clusterName} did not include an id.`);
    return record;
  }

  try {
    await output("terraform", [`-chdir=${terraformDirectory}`, "import", terraformAddress, selectedCluster.clusterId]);
    record.action = "imported";
    record.result = "success";
  } catch (error) {
    record.errors.push(describeError(error));
  }

  return record;
}

function normalizeDnsName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
}

export function previewDnsFqdns(prNumber, baseDomain = PREVIEW_DNS_BASE_DOMAIN) {
  const parsed = Number.parseInt(String(prNumber ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Preview PR number must be a positive integer.");
  }
  const normalizedBase = normalizeDnsName(baseDomain) || PREVIEW_DNS_BASE_DOMAIN;
  const apex = `pr-${parsed}.${PREVIEW_DNS_ENVIRONMENT_LABEL}.${normalizedBase}`;
  return { prNumber: parsed, baseDomain: normalizedBase, apex, wildcard: `*.${apex}` };
}

export function resolvePreviewDnsZone(registeredDomains, fqdn, fallback = PREVIEW_DNS_BASE_DOMAIN) {
  const normalizedFqdn = normalizeDnsName(fqdn);
  const names = (Array.isArray(registeredDomains) ? registeredDomains : [])
    .map((domain) => normalizeDnsName(domain?.name ?? domain?.Name ?? domain))
    .filter(Boolean);
  const matches = names.filter((name) => normalizedFqdn === name || normalizedFqdn.endsWith(`.${name}`));
  matches.sort((left, right) => right.length - left.length);
  return matches[0] ?? normalizeDnsName(fallback);
}

export function previewDnsRecordName(fqdn, zone) {
  const normalizedFqdn = normalizeDnsName(fqdn);
  const normalizedZone = normalizeDnsName(zone);
  if (normalizedFqdn === normalizedZone) {
    return "@";
  }
  if (normalizedFqdn.endsWith(`.${normalizedZone}`)) {
    return normalizedFqdn.slice(0, -normalizedZone.length - 1);
  }
  throw new Error(`${normalizedFqdn} is not inside DNS zone ${normalizedZone}.`);
}

// The ONE shared wildcard record every preview host resolves through:
// `pr-<n>`, `pr-<n>-marketplace`, and `pr-<n>-admin` are each a
// single label under preview.chasesets.com, so this one record -- applied
// once by the `apply-shared-dns` bootstrap command, never per-PR -- covers
// every preview forever, with no new DNS record created per PR.
export function previewSharedDnsRecordPlan(options = {}) {
  const fqdn = PREVIEW_SHARED_DNS_FQDN;
  const baseDomain = options.baseDomain ?? PREVIEW_DNS_BASE_DOMAIN;
  const zone = resolvePreviewDnsZone(options.registeredDomains ?? [], fqdn, baseDomain);
  return {
    zone,
    target: options.target ?? null,
    record: { role: "wildcard", fqdn, name: previewDnsRecordName(fqdn, zone) },
  };
}

export function previewPrNumberFromDnsRecordFqdn(fqdn, baseDomain = PREVIEW_DNS_BASE_DOMAIN) {
  const normalized = normalizeDnsName(fqdn);
  const base = normalizeDnsName(baseDomain);
  const pattern = new RegExp(`^(?:\\*\\.)?pr-(\\d+)\\.${PREVIEW_DNS_ENVIRONMENT_LABEL}\\.${escapeRegExp(base)}$`);
  const match = normalized.match(pattern);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function selectPreviewDnsRecordTargets(records, zone, options = {}) {
  const normalizedZone = normalizeDnsName(zone);
  const baseDomain = options.baseDomain ?? PREVIEW_DNS_BASE_DOMAIN;
  const byPr = new Map();

  for (const record of Array.isArray(records) ? records : []) {
    const type = String(record?.type ?? record?.Type ?? "").toUpperCase();
    if (type !== "A") {
      continue;
    }
    const name = normalizeDnsName(record?.name ?? record?.Name);
    const fqdn = name === "@" || name === "" ? normalizedZone : `${name}.${normalizedZone}`;
    const prNumber = previewPrNumberFromDnsRecordFqdn(fqdn, baseDomain);
    if (!prNumber) {
      continue;
    }
    const entry = byPr.get(prNumber) ?? { prNumber, zone: normalizedZone, records: [] };
    entry.records.push({
      id: String(record?.id ?? record?.ID ?? record?.Id ?? ""),
      name,
      fqdn,
      data: String(record?.data ?? record?.Data ?? ""),
    });
    byPr.set(prNumber, entry);
  }

  return [...byPr.values()]
    .map((entry) => ({
      ...entry,
      records: entry.records.sort((left, right) => left.fqdn.localeCompare(right.fqdn)),
    }))
    .sort((left, right) => left.prNumber - right.prNumber);
}

function listPreviewDomains(dependencies) {
  const listDomains =
    dependencies.listDomains ??
    (() => commandJson("doctl", ["compute", "domain", "list", "--output", "json"], dependencies));
  return listDomains;
}

function listPreviewDomainRecords(dependencies) {
  const listDomainRecords =
    dependencies.listDomainRecords ??
    ((zone) => commandJson("doctl", ["compute", "domain", "records", "list", zone, "--output", "json"], dependencies));
  return listDomainRecords;
}

// One-time (and re-runnable/idempotent) bootstrap: ensures the single shared
// `*.preview.chasesets.com` wildcard A record exists and points at the DOKS
// ingress load balancer. Part of the docs/runbooks/doks-platform-operations.md
// bootstrap alongside `doks-cluster-addons.mjs --environment staging`; never
// invoked per-PR.
export async function applySharedPreviewDnsRecord(options, dependencies = {}) {
  const record = {
    schemaVersion: DIGITALOCEAN_PREVIEW_DNS_VERSION,
    mode: "apply-shared",
    zone: null,
    target: String(options.target ?? "").trim(),
    action: null,
    result: "failure",
    warnings: [],
    errors: [],
  };

  if (!PREVIEW_DNS_IPV4_PATTERN.test(record.target)) {
    record.errors.push("--target must be a valid IPv4 address (the DOKS ingress load balancer).");
    return record;
  }

  const listDomains = listPreviewDomains(dependencies);
  const listDomainRecords = listPreviewDomainRecords(dependencies);
  const createRecord =
    dependencies.createDomainRecord ??
    ((zone, name, data) =>
      commandOutput(
        "doctl",
        [
          "compute",
          "domain",
          "records",
          "create",
          zone,
          "--record-type",
          "A",
          "--record-name",
          name,
          "--record-data",
          data,
          "--record-ttl",
          String(PREVIEW_DNS_RECORD_TTL),
        ],
        dependencies,
      ));
  const deleteRecord =
    dependencies.deleteDomainRecord ??
    ((zone, id) =>
      commandOutput("doctl", ["compute", "domain", "records", "delete", zone, id, "--force"], dependencies));

  let domains = [];
  try {
    domains = normalizeDomainList(await listDomains());
  } catch (error) {
    record.errors.push("DigitalOcean domain listing failed.");
    record.errors.push(describeError(error));
    return record;
  }

  const plan = previewSharedDnsRecordPlan({
    registeredDomains: domains,
    baseDomain: options.baseDomain,
    target: record.target,
  });
  record.zone = plan.zone;

  let existing = [];
  try {
    existing = await listDomainRecords(plan.zone);
  } catch (error) {
    record.errors.push(`Listing DNS records for ${plan.zone} failed.`);
    record.errors.push(describeError(error));
    return record;
  }
  const existingRecords = Array.isArray(existing) ? existing : [];

  const matches = existingRecords.filter(
    (candidate) =>
      String(candidate?.type ?? candidate?.Type ?? "").toUpperCase() === "A" &&
      normalizeDnsName(candidate?.name ?? candidate?.Name) === normalizeDnsName(plan.record.name),
  );
  const alreadyPointed =
    matches.length === 1 && String(matches[0]?.data ?? matches[0]?.Data ?? "").trim() === record.target;
  if (alreadyPointed) {
    record.action = "unchanged";
    record.result = "success";
    return record;
  }

  try {
    for (const stale of matches) {
      const id = String(stale?.id ?? stale?.ID ?? stale?.Id ?? "");
      if (id) {
        await deleteRecord(plan.zone, id);
      }
    }
    await createRecord(plan.zone, plan.record.name, record.target);
    record.action = matches.length > 0 ? "replaced" : "created";
    record.result = "success";
  } catch (error) {
    record.errors.push(`Failed to upsert ${plan.record.fqdn}: ${describeError(error)}`);
  }

  return record;
}

export async function destroyPreviewDnsRecords(options, dependencies = {}) {
  const record = {
    schemaVersion: DIGITALOCEAN_PREVIEW_DNS_VERSION,
    mode: "destroy",
    prNumber: null,
    zone: null,
    deletedRecords: [],
    result: "failure",
    warnings: [],
    errors: [],
  };

  const parsedPr = Number.parseInt(String(options.prNumber ?? ""), 10);
  if (!Number.isInteger(parsedPr) || parsedPr <= 0) {
    record.errors.push("--pr-number must be a positive integer.");
    return record;
  }

  const listDomains = listPreviewDomains(dependencies);
  const listDomainRecords = listPreviewDomainRecords(dependencies);
  const deleteRecord =
    dependencies.deleteDomainRecord ??
    ((zone, id) =>
      commandOutput("doctl", ["compute", "domain", "records", "delete", zone, id, "--force"], dependencies));

  let domains = [];
  try {
    domains = normalizeDomainList(await listDomains());
  } catch (error) {
    record.errors.push("DigitalOcean domain listing failed.");
    record.errors.push(describeError(error));
    return record;
  }

  const { apex, baseDomain } = previewDnsFqdns(parsedPr, options.baseDomain);
  const zone = resolvePreviewDnsZone(domains, apex, baseDomain);
  record.prNumber = parsedPr;
  record.zone = zone;

  let existing = [];
  try {
    existing = await listDomainRecords(zone);
  } catch (error) {
    record.errors.push(`Listing DNS records for ${zone} failed.`);
    record.errors.push(describeError(error));
    return record;
  }

  const targets = selectPreviewDnsRecordTargets(existing, zone, { baseDomain }).filter(
    (target) => target.prNumber === parsedPr,
  );
  for (const target of targets) {
    for (const dnsRecord of target.records) {
      if (!dnsRecord.id) {
        record.warnings.push(`Preview DNS record ${dnsRecord.fqdn} had no id; skipped deletion.`);
        continue;
      }
      try {
        await deleteRecord(zone, dnsRecord.id);
        record.deletedRecords.push({ fqdn: dnsRecord.fqdn, id: dnsRecord.id });
      } catch (error) {
        record.errors.push(`Failed to delete ${dnsRecord.fqdn}: ${describeError(error)}`);
      }
    }
  }

  record.result = record.errors.length > 0 ? "failure" : "success";
  return record;
}

async function fetchGithubPullRequest(input) {
  const response = await fetch(`https://api.github.com/repos/${input.repository}/pulls/${input.prNumber}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`GitHub pull request lookup returned ${response.status}.`);
  }

  if (!input.signal) {
    return response.json();
  }
  return Promise.race([
    response.json(),
    new Promise((_, reject) => {
      if (input.signal.aborted) {
        reject(input.signal.reason ?? new Error("GitHub pull request lookup timed out."));
        return;
      }
      input.signal.addEventListener(
        "abort",
        () => reject(input.signal.reason ?? new Error("GitHub pull request lookup timed out.")),
        { once: true },
      );
    }),
  ]);
}

async function fetchGithubOpenPullRequestPage(input) {
  const response = await fetch(
    `https://api.github.com/repos/${input.repository}/pulls?state=open&per_page=${OPEN_PULL_REQUEST_PAGE_SIZE}&page=${input.page}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub open pull request listing page ${input.page} returned ${response.status}.`);
  }

  return response.json();
}

function validateIdleDraftOptions(options) {
  const errors = [];
  if (!isNonEmptyString(options.repository)) {
    errors.push("--repo is required.");
  }
  if (!isNonEmptyString(options.githubToken)) {
    errors.push("--github-token is required.");
  }
  if (!Number.isFinite(Date.parse(options.checkedAt ?? ""))) {
    errors.push("--checked-at must be an ISO timestamp.");
  }
  const prNumber = options.prNumber ?? null;
  if (prNumber !== null) {
    if (!(Number.isInteger(prNumber) && prNumber > 0)) {
      errors.push("--pr-number must be a positive integer.");
    }
    for (const key of ["checkoutRef", "imageSha"]) {
      if (!isNonEmptyString(options[key])) {
        errors.push(`--${kebabCase(key)} is required with --pr-number.`);
      }
    }
  }
  return errors;
}

function validateDiscoverOptions(options) {
  const errors = [];
  for (const key of ["bucket", "endpointUrl", "prefix", "repository", "checkoutRef", "imageSha", "checkedAt"]) {
    if (!isNonEmptyString(options[key])) {
      errors.push(`--${kebabCase(key)} is required.`);
    }
  }
  if (!isNonEmptyString(options.githubToken)) {
    errors.push("--github-token is required.");
  }
  return errors;
}

function parseDiscoverArgs(argv, env = process.env) {
  return {
    bucket: readOption(argv, "--bucket", env.TERRAFORM_STATE_BUCKET ?? DEFAULT_STATE_BUCKET),
    endpointUrl: readOption(argv, "--endpoint-url", env.SPACES_ENDPOINT_URL ?? DEFAULT_SPACES_ENDPOINT),
    prefix: readOption(argv, "--prefix", env.PREVIEW_STATE_PREFIX ?? DEFAULT_PREVIEW_STATE_PREFIX),
    repository: readOption(argv, "--repo", env.GITHUB_REPOSITORY ?? ""),
    githubToken: readOption(argv, "--github-token", env.GITHUB_TOKEN ?? ""),
    checkoutRef: readOption(argv, "--checkout-ref", env.PREVIEW_CLEANUP_CHECKOUT_REF ?? ""),
    imageSha: readOption(argv, "--image-sha", env.PREVIEW_CLEANUP_IMAGE_SHA ?? ""),
    checkedAt: readOption(argv, "--checked-at", new Date().toISOString()),
    outPath: readOption(argv, "--out", env.PREVIEW_CLEANUP_SWEEP_OUT),
    githubOutputPath: readOption(argv, "--github-output", env.GITHUB_OUTPUT),
  };
}

function parseIdleDraftArgs(argv, env = process.env) {
  // A present but empty or non-numeric --pr-number is an invalid re-check,
  // never a fallback to the full sweep.
  const rawPrNumber = readOption(argv, "--pr-number", hasOption(argv, "--pr-number") ? "" : null);
  return {
    prNumber: rawPrNumber === null ? null : /^\d+$/.test(rawPrNumber) ? Number.parseInt(rawPrNumber, 10) : Number.NaN,
    repository: readOption(argv, "--repo", env.GITHUB_REPOSITORY ?? ""),
    githubToken: readOption(argv, "--github-token", env.GITHUB_TOKEN ?? ""),
    checkoutRef: readOption(argv, "--checkout-ref", ""),
    imageSha: readOption(argv, "--image-sha", ""),
    checkedAt: readOption(argv, "--checked-at", new Date().toISOString()),
    outPath: readOption(argv, "--out", undefined),
    githubOutputPath: readOption(argv, "--github-output", env.GITHUB_OUTPUT),
  };
}

function parseInventoryArgs(argv, env = process.env) {
  return {
    repository: readOption(argv, "--repo", env.GITHUB_REPOSITORY ?? ""),
    githubToken: readOption(argv, "--github-token", env.GITHUB_TOKEN ?? ""),
    checkedAt: readOption(argv, "--checked-at", new Date().toISOString()),
    outPath: readOption(argv, "--out", env.PREVIEW_DATABASE_CLEANUP_OUT),
  };
}

function parseCleanupDatabasesArgs(argv, env = process.env) {
  return {
    ...parseInventoryArgs(argv, env),
    delete: hasOption(argv, "--delete"),
    confirm: readOption(argv, "--confirm", env.PREVIEW_DATABASE_CLEANUP_CONFIRM ?? ""),
  };
}

function parseImportDatabaseArgs(argv, env = process.env) {
  return {
    prNumber: readOption(argv, "--pr-number", env.PREVIEW_PR_NUMBER ?? ""),
    clusterName: readOption(argv, "--cluster-name", env.PREVIEW_DATABASE_CLUSTER_NAME),
    terraformDirectory: readOption(
      argv,
      "--terraform-directory",
      env.PREVIEW_TERRAFORM_DIRECTORY ?? "infrastructure/digitalocean/platform",
    ),
    terraformAddress: readOption(
      argv,
      "--terraform-address",
      env.PREVIEW_DATABASE_TERRAFORM_ADDRESS ?? PREVIEW_DATABASE_TERRAFORM_ADDRESS,
    ),
    checkedAt: readOption(argv, "--checked-at", new Date().toISOString()),
    outPath: readOption(argv, "--out", env.PREVIEW_DATABASE_CLEANUP_OUT),
  };
}

function parseRetireStateArgs(argv, env = process.env) {
  const rawPrNumber = readOption(argv, "--pr-number", env.PREVIEW_PR_NUMBER ?? "");
  return {
    prNumber: /^\d+$/.test(rawPrNumber) ? Number.parseInt(rawPrNumber, 10) : Number.NaN,
    bucket: readOption(argv, "--bucket", env.TERRAFORM_STATE_BUCKET ?? DEFAULT_STATE_BUCKET),
    endpointUrl: readOption(argv, "--endpoint-url", env.SPACES_ENDPOINT_URL ?? DEFAULT_SPACES_ENDPOINT),
    prefix: readOption(argv, "--prefix", env.PREVIEW_STATE_PREFIX ?? DEFAULT_PREVIEW_STATE_PREFIX),
    terraformDirectory: readOption(
      argv,
      "--terraform-directory",
      env.PREVIEW_TERRAFORM_DIRECTORY ?? "infrastructure/digitalocean/platform",
    ),
    checkedAt: readOption(argv, "--checked-at", new Date().toISOString()),
    cleanupSucceeded: readOption(argv, "--cleanup-succeeded", "false") === "true",
    outPath: readOption(argv, "--out", env.PREVIEW_STATE_RETIREMENT_OUT),
  };
}

function parseApplySharedDnsArgs(argv, env = process.env) {
  return {
    target: readOption(argv, "--target", env.DOKS_INGRESS_TARGET ?? ""),
    baseDomain: readOption(argv, "--base-domain", env.PREVIEW_DNS_BASE_DOMAIN ?? PREVIEW_DNS_BASE_DOMAIN),
    outPath: readOption(argv, "--out", env.PREVIEW_DNS_RECORD_OUT),
  };
}

function parseDestroyDnsArgs(argv, env = process.env) {
  return {
    prNumber: readOption(argv, "--pr-number", env.PREVIEW_PR_NUMBER ?? ""),
    baseDomain: readOption(argv, "--base-domain", env.PREVIEW_DNS_BASE_DOMAIN ?? PREVIEW_DNS_BASE_DOMAIN),
    outPath: readOption(argv, "--out", env.PREVIEW_DNS_RECORD_OUT),
  };
}

function readOption(argv, name, fallback) {
  const inlinePrefix = `${name}=`;
  const inline = argv.find((entry) => entry.startsWith(inlinePrefix));
  if (inline) {
    return inline.slice(inlinePrefix.length);
  }
  const index = argv.indexOf(name);
  if (index !== -1 && index + 1 < argv.length) {
    return argv[index + 1];
  }
  return fallback;
}

function hasOption(argv, name) {
  return argv.includes(name);
}

async function writeGithubOutputs(outputPath, outputs) {
  if (!outputPath) {
    return;
  }
  const lines = [];
  for (const [key, value] of Object.entries(outputs)) {
    lines.push(`${key}=${String(value)}`);
  }
  await writeFile(outputPath, `${lines.join("\n")}\n`, { flag: "a" });
}

function normalizeDomainList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.domains)) {
    return value.domains;
  }
  if (Array.isArray(value?.Domains)) {
    return value.Domains;
  }
  return [];
}

function normalizeDatabaseClusters(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.databases)) {
    return value.databases;
  }
  if (Array.isArray(value?.database_clusters)) {
    return value.database_clusters;
  }
  if (Array.isArray(value?.items)) {
    return value.items;
  }
  return [];
}

function databaseClusterName(cluster) {
  return String(cluster?.name ?? cluster?.Name ?? "");
}

function databaseClusterId(cluster) {
  return String(cluster?.id ?? cluster?.ID ?? cluster?.Id ?? cluster?.uuid ?? "");
}

function databaseClusterTags(cluster) {
  const tags = cluster?.tags ?? cluster?.Tags ?? [];
  if (Array.isArray(tags)) {
    return tags.map((tag) => String(tag)).filter(Boolean);
  }
  return String(tags)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function pullRequestStateLabel(pullRequest) {
  const state = String(pullRequest.state ?? "unknown").toLowerCase();
  return state === "closed" && pullRequest.merged ? "merged" : state;
}

function trimSlashes(value) {
  return String(value ?? "").replace(/^\/+|\/+$/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function kebabCase(value) {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function describeError(error) {
  return error instanceof Error ? error.message.replace(/\s+/g, " ").trim().slice(0, 500) : String(error);
}

async function writeOptionalRecord(path, record) {
  if (path) {
    await writeJsonRecord(path, record);
  }
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "";
  const commandArgs = argv.slice(1);

  if (command === "discover") {
    const options = parseDiscoverArgs(commandArgs);
    const result = await discoverPreviewCleanupTargets(options);
    await writeOptionalRecord(options.outPath, result.record);
    await writeGithubOutputs(options.githubOutputPath, {
      matrix: JSON.stringify(result.matrix),
      target_count: result.matrix.include.length,
      result: result.record.result,
    });
    return result.record.result === "failure" ? 1 : 0;
  }

  if (command === "discover-idle-drafts") {
    const options = parseIdleDraftArgs(commandArgs);
    const result = await discoverIdleDraftPreviews(options);
    await writeOptionalRecord(options.outPath, result.record);
    await writeGithubOutputs(options.githubOutputPath, {
      result: result.record.result,
      target_count: result.record.selected.length,
      pr_numbers: result.record.selected.map((target) => target.prNumber).join(" "),
      ...(result.record.mode === "recheck"
        ? { matrix: JSON.stringify(result.matrix), reason: result.record.recheck?.reason ?? "re-check failed" }
        : {}),
    });
    console.log(JSON.stringify(result.record, null, 2));
    return result.record.result === "failure" ? 1 : 0;
  }

  if (command === "inventory") {
    const options = parseInventoryArgs(commandArgs);
    const record = await buildPreviewDatabaseClusterInventory(options);
    await writeOptionalRecord(options.outPath, record);
    console.log(JSON.stringify(record, null, 2));
    return record.result === "failure" ? 1 : 0;
  }

  if (command === "cleanup-databases") {
    const options = parseCleanupDatabasesArgs(commandArgs);
    const record = await cleanupLeakedPreviewDatabaseClusters(options);
    await writeOptionalRecord(options.outPath, record);
    console.log(JSON.stringify(record, null, 2));
    return record.result === "failure" ? 1 : 0;
  }

  if (command === "import-database") {
    const options = parseImportDatabaseArgs(commandArgs);
    const record = await importPreviewDatabaseClusterIntoTerraformState(options);
    await writeOptionalRecord(options.outPath, record);
    console.log(JSON.stringify(record, null, 2));
    return record.result === "failure" ? 1 : 0;
  }

  if (command === "retire-state") {
    const options = parseRetireStateArgs(commandArgs);
    const record = await retirePreviewTerraformState(options);
    await writeOptionalRecord(options.outPath, record);
    console.log(JSON.stringify(record, null, 2));
    return record.result === "failure" ? 1 : 0;
  }

  if (command === "apply-shared-dns") {
    const options = parseApplySharedDnsArgs(commandArgs);
    const record = await applySharedPreviewDnsRecord(options);
    await writeOptionalRecord(options.outPath, record);
    console.log(JSON.stringify(record, null, 2));
    return record.result === "failure" ? 1 : 0;
  }

  if (command === "destroy-dns") {
    const options = parseDestroyDnsArgs(commandArgs);
    const record = await destroyPreviewDnsRecords(options);
    await writeOptionalRecord(options.outPath, record);
    console.log(JSON.stringify(record, null, 2));
    return record.result === "failure" ? 1 : 0;
  }

  throw new Error(
    "Usage: node scripts/digitalocean-preview-cleanup-sweep.mjs <discover|discover-idle-drafts|inventory|cleanup-databases|import-database|apply-shared-dns|destroy-dns> [options]",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
