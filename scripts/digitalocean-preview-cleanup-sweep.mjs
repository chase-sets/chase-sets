import { execFile } from "node:child_process";
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
export const PREVIEW_DATABASE_TERRAFORM_ADDRESS = "digitalocean_database_cluster.postgres";
export const PREVIEW_DATABASE_DELETE_CONFIRMATION = "delete leaked preview database clusters";

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

function commandOutput(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
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
          reject(new Error(`${command} ${args.join(" ")} failed: ${message}`));
          return;
        }

        resolve(stdout);
      },
    );
  });
}

async function commandJson(command, args, dependencies = {}) {
  const output = await (dependencies.commandOutput ?? commandOutput)(command, args);
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

export function selectPreviewNamespaceTargets(namespaces) {
  const prNumbers = new Set();

  for (const namespace of Array.isArray(namespaces) ? namespaces : []) {
    const name = typeof namespace === "string" ? namespace : (namespace?.metadata?.name ?? namespace?.name ?? "");
    const prNumber = previewPrNumberFromNamespaceName(name);
    if (prNumber) {
      prNumbers.add(prNumber);
    }
  }

  return [...prNumbers]
    .sort((left, right) => left - right)
    .map((prNumber) => ({ prNumber, namespace: `chase-sets-pr-${prNumber}` }));
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

export async function discoverPreviewCleanupTargets(options, dependencies = {}) {
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
    result: "failure",
    warnings: [],
    errors,
  };
  if (errors.length > 0) {
    return { record: baseRecord, matrix: { include: [] } };
  }

  const awsJson =
    dependencies.awsJson ??
    ((args) => commandJson("aws", [...args, "--endpoint-url", options.endpointUrl], dependencies));
  const listDatabaseClusters =
    dependencies.listDatabaseClusters ??
    (() => commandJson("doctl", ["databases", "list", "--output", "json"], dependencies));
  const listDomains = listPreviewDomains(dependencies);
  const listDomainRecords = listPreviewDomainRecords(dependencies);
  const listNamespaces =
    dependencies.listNamespaces ?? (() => commandJson("kubectl", ["get", "namespaces", "-o", "json"], dependencies));
  const fetchPullRequest =
    dependencies.fetchPullRequest ??
    ((prNumber) =>
      fetchGithubPullRequest({
        repository: options.repository,
        githubToken: options.githubToken,
        prNumber,
      }));

  const record = { ...baseRecord, dnsRecordCandidates: [], namespaceCandidates: [], errors: [], warnings: [] };
  try {
    const listed = await awsJson([
      "s3api",
      "list-objects-v2",
      "--bucket",
      options.bucket,
      "--prefix",
      `${record.prefix}/`,
    ]);
    record.stateCandidates = selectPreviewStateTargets(listed.Contents ?? listed.contents ?? [], {
      prefix: record.prefix,
    });
  } catch (error) {
    record.errors.push("Preview Terraform state listing failed.");
    record.errors.push(describeError(error));
    return { record, matrix: { include: [] } };
  }

  try {
    record.databaseClusterCandidates = selectPreviewDatabaseClusterTargets(await listDatabaseClusters());
  } catch (error) {
    record.warnings.push("Preview database cluster listing failed; state-backed cleanup targets were still evaluated.");
    record.warnings.push(describeError(error));
  }

  // Leftover per-preview DNS records for closed PRs are drift, exactly like a
  // leaked managed cluster: the Kubernetes preview path now creates a
  // `pr-<n>.preview` apex + `*.pr-<n>.preview` wildcard, and a closed PR must
  // not leave either behind. Surface them as cleanup candidates so the destroy
  // matrix removes them even when no Terraform state or managed cluster remains.
  try {
    const domains = normalizeDomainList(await listDomains());
    const zone = resolvePreviewDnsZone(
      domains,
      `${PREVIEW_DNS_ENVIRONMENT_LABEL}.${PREVIEW_DNS_BASE_DOMAIN}`,
      PREVIEW_DNS_BASE_DOMAIN,
    );
    record.dnsRecordCandidates = selectPreviewDnsRecordTargets(await listDomainRecords(zone), zone);
  } catch (error) {
    record.warnings.push("Preview DNS record listing failed; state and cluster cleanup targets were still evaluated.");
    record.warnings.push(describeError(error));
  }

  // A closed PR's namespace is the leak this sweep exists to catch:
  // Terraform never created it, so it never appears in Terraform state, and
  // it can outlive its database cluster and DNS records once those are
  // cleaned up by an earlier partial run. Ask the live cluster directly.
  // Listing failure (e.g. no kubeconfig configured for this run) only
  // degrades this one candidate source to a warning; state/cluster/DNS-backed
  // reconciliation still proceeds.
  try {
    record.namespaceCandidates = selectPreviewNamespaceTargets(await listNamespaces());
  } catch (error) {
    record.warnings.push(
      "Preview namespace listing failed; state, cluster, and DNS cleanup targets were still evaluated.",
    );
    record.warnings.push(describeError(error));
  }

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

  for (const candidate of record.candidates) {
    try {
      const pullRequest = await fetchPullRequest(candidate.prNumber);
      const state = String(pullRequest.state ?? "unknown").toLowerCase();
      const target = {
        ...candidate,
        pullRequestState: state,
        merged: Boolean(pullRequest.merged),
        selected: state === "closed",
      };
      if (target.selected) {
        record.targets.push(target);
      }
    } catch (error) {
      record.errors.push(`PR #${candidate.prNumber} lookup failed: ${describeError(error)}`);
    }
  }

  record.result = record.errors.length > 0 ? "failure" : record.warnings.length > 0 ? "warning" : "success";
  return {
    record,
    matrix: cleanupMatrixForTargets(record.targets, {
      checkoutRef: options.checkoutRef,
      imageSha: options.imageSha,
    }),
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
  });
  if (!response.ok) {
    throw new Error(`GitHub pull request lookup returned ${response.status}.`);
  }

  return response.json();
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
    "Usage: node scripts/digitalocean-preview-cleanup-sweep.mjs <discover|inventory|cleanup-databases|import-database|apply-shared-dns|destroy-dns> [options]",
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
