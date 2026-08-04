#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readEnv, readOption, readRepeatedOptions } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

const execFile = promisify(execFileCallback);

export const DIGITALOCEAN_DRIFT_DIGEST_VERSION = "digitalocean-drift-digest/v1";
const RESTORE_POINT_PREFIX = "cs-prod-rp-";
const RESTORE_DRILL_PREFIX = "cs-stg-drill-";
const RESTORE_POINT_HOLD_AUTHORITY_ALIAS = "DIGITALOCEAN_DRIFT_RESTORE_POINT_HOLD_NAMES";
const CANONICAL_DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_REPOSITORY = "chase-sets-platform";

const OBSERVABILITY_POLICIES = {
  shared: {
    dropletBackupsExpected: false,
    acceptableTelemetryDataLossWindowHours: 24,
    volumeProtection: "accepted-short-retention-with-manual-snapshot-before-maintenance",
    volumeSizeGibMinimum: 50,
    volumeSizeGibMaximum: 100,
  },
};

const DATABASE_BACKUP_POLICIES = {
  staging: {
    maximumAgeHours: 48,
  },
  production: {
    maximumAgeHours: 26,
  },
};

const TERRAFORM_ROOTS = {
  platform: "infrastructure/digitalocean/platform",
  catalogAssets: "infrastructure/digitalocean/catalog-assets",
  stateBootstrap: "infrastructure/digitalocean/state-bootstrap",
  observability: "infrastructure/digitalocean/observability",
};

export function parseDigitalOceanDriftDigestArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("DIGITALOCEAN_DRIFT_DIGEST_OUT", env),
    doctlPath: readOption(argv, "--doctl") ?? readEnv("DOCTL_PATH", env) ?? "doctl",
    repository: readOption(argv, "--repository") ?? readEnv("PLATFORM_IMAGE_REPOSITORY", env) ?? DEFAULT_REPOSITORY,
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    restorePointMinAgeHours: parseNumber(
      readOption(argv, "--restore-point-min-age-hours") ??
        readEnv("DIGITALOCEAN_DRIFT_RESTORE_POINT_MIN_AGE_HOURS", env) ??
        "24",
      "DIGITALOCEAN_DRIFT_RESTORE_POINT_MIN_AGE_HOURS",
    ),
    registryRetentionDays: parseNumber(
      readOption(argv, "--registry-retention-days") ??
        readEnv("DIGITALOCEAN_DRIFT_REGISTRY_RETENTION_DAYS", env) ??
        "7",
      "DIGITALOCEAN_DRIFT_REGISTRY_RETENTION_DAYS",
    ),
    restorePointHoldNames: parseHoldNames([
      ...readRepeatedOptions(argv, "--hold-name"),
      readEnv(RESTORE_POINT_HOLD_AUTHORITY_ALIAS, env),
    ]),
  };
}

export async function runDigitalOceanDriftDigest(options, dependencies = {}) {
  const result = await buildDigitalOceanDriftDigest(options, dependencies);
  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }
  return result;
}

export async function buildDigitalOceanDriftDigest(options, dependencies = {}) {
  const exec = dependencies.execFile ?? execFile;
  const collection = await collectDigitalOceanSnapshot(options, exec);
  const snapshot = collection.snapshot;
  const checkedAt = new Date(options.checkedAt);
  const restorePointCutoff = new Date(checkedAt.getTime() - options.restorePointMinAgeHours * 60 * 60 * 1000);
  const registryCutoff = new Date(checkedAt.getTime() - options.registryRetentionDays * 24 * 60 * 60 * 1000);
  const restorePointHoldAuthority = resolveRestorePointHoldAuthority(
    options.restorePointHoldNames ?? [],
    snapshot.databases,
  );

  const apps = snapshot.apps.map((app) => summarizeApp(app));
  const databases = snapshot.databases.map((database, index) =>
    summarizeDatabase(database, restorePointCutoff, restorePointHoldAuthority.heldDatabaseIndexes.has(index)),
  );
  const databaseBackups = snapshot.databaseBackups.map((backup) => summarizeDatabaseBackup(backup, checkedAt));
  const registryTags = snapshot.registryTags.map((tag) => summarizeRegistryTag(tag, registryCutoff));
  const droplets = snapshot.droplets.map(summarizeDroplet);
  const volumes = snapshot.volumes.map(summarizeVolume);
  const uptimeChecks = snapshot.uptimeChecks.map((check) =>
    summarizeUptimeCheck(check, snapshot.uptimeAlertsByCheckId),
  );
  const cdns = snapshot.cdns.map(summarizeCdn);
  const findings = [
    ...apps.flatMap(appFindings),
    ...databases.flatMap(databaseFindings),
    ...databaseBackups.flatMap(databaseBackupFindings),
    ...registryTags.flatMap(registryTagFindings),
    ...droplets.flatMap(dropletFindings),
    ...volumes.flatMap(volumeFindings),
    ...uptimeChecks.flatMap(uptimeCheckFindings),
    ...cdns.flatMap(cdnFindings),
    ...(restorePointHoldAuthority.finding ? [restorePointHoldAuthority.finding] : []),
    ...collection.errors.map(collectionErrorFinding),
  ];

  const record = {
    schemaVersion: DIGITALOCEAN_DRIFT_DIGEST_VERSION,
    checkedAt: options.checkedAt,
    mode: "advisory-read-only",
    terraformRoots: TERRAFORM_ROOTS,
    policies: {
      restorePointPrefix: RESTORE_POINT_PREFIX,
      restoreDrillPrefix: RESTORE_DRILL_PREFIX,
      restorePointMinAgeHours: options.restorePointMinAgeHours,
      registryRepository: options.repository,
      registryRetentionDays: options.registryRetentionDays,
      releaseTagPrefix: "release-",
      retiredComputeProvider: "digitalocean-apps",
      observability: OBSERVABILITY_POLICIES,
      databaseBackups: DATABASE_BACKUP_POLICIES,
      restorePointHolds: restorePointHoldAuthority.policy,
    },
    collections: collection.collections,
    expectedResources: {
      apps: [],
      databases: ["chase-sets-postgres", "chase-sets-staging-postgres"],
      forbiddenPreviewDatabases: ["chase-sets-pr-<number>-postgres"],
      restorePoints: [`${RESTORE_POINT_PREFIX}<release-timestamp>-<sha>`],
      restoreDrills: [`${RESTORE_DRILL_PREFIX}<yyyymmdd>-<run-id>-<attempt>`],
      registryRepositories: [options.repository],
      catalogAssetBuckets: [
        "chase-sets-preview-catalog-assets",
        "chase-sets-staging-catalog-assets",
        "chase-sets-production-catalog-assets",
      ],
      observabilityHosts: ["chase-sets-observability"],
      observabilityVolumes: ["chase-sets-observability-data"],
    },
    resources: {
      apps,
      databases,
      databaseBackups,
      registryTags,
      droplets,
      volumes,
      uptimeChecks,
      cdns,
      spacesBuckets: {
        status: "expected-only",
        reason:
          "doctl does not expose a general Spaces bucket list command in the repo-supported surfaces; bucket ownership is represented from Terraform naming until an S3 inventory probe is added.",
        expected: [
          {
            name: "chase-sets-terraform-state",
            terraformRoot: TERRAFORM_ROOTS.stateBootstrap,
          },
          {
            name: "chase-sets-preview-catalog-assets",
            terraformRoot: TERRAFORM_ROOTS.catalogAssets,
          },
          {
            name: "chase-sets-staging-catalog-assets",
            terraformRoot: TERRAFORM_ROOTS.catalogAssets,
          },
          {
            name: "chase-sets-production-catalog-assets",
            terraformRoot: TERRAFORM_ROOTS.catalogAssets,
          },
        ],
      },
    },
    findings,
    summary: summarizeDigest({
      apps,
      databases,
      databaseBackups,
      registryTags,
      droplets,
      volumes,
      uptimeChecks,
      cdns,
      findings,
      collectionErrors: collection.errors,
    }),
    result:
      findings.some((finding) => finding.severity === "warning") || collection.errors.length > 0
        ? "warning"
        : "success",
  };

  return { record, passesDigestGate: true };
}

async function collectDigitalOceanSnapshot(options, exec) {
  const collections = {};
  const errors = [];
  const collect = async (name, args) => {
    try {
      const items = await commandJson(exec, options.doctlPath, args);
      collections[name] = { status: "success", command: [options.doctlPath, ...args], count: items.length };
      return items;
    } catch (error) {
      const diagnostic = describeDoctlFailure(error);
      collections[name] = { status: "failed", command: [options.doctlPath, ...args], count: 0, error: diagnostic };
      errors.push({ collection: name, command: [options.doctlPath, ...args], error: diagnostic });
      return [];
    }
  };

  const apps = await collect("apps", ["apps", "list", "--output", "json"]);
  const appDetails = [];
  for (const app of apps.filter((app) =>
    readField(app, "name", "Name", "spec.name", "Spec.Name")?.includes("chase-sets"),
  )) {
    const id = readField(app, "id", "ID");
    if (!id) {
      appDetails.push(app);
      continue;
    }
    try {
      appDetails.push(await commandJsonObject(exec, options.doctlPath, ["apps", "get", id, "--output", "json"]));
    } catch {
      appDetails.push(app);
    }
  }

  const uptimeChecks = await collect("uptimeChecks", ["monitoring", "uptime", "list", "--output", "json"]);
  const uptimeAlertsByCheckId = {};
  for (const check of uptimeChecks) {
    const id = readField(check, "id", "ID");
    if (!id) {
      continue;
    }
    try {
      const alerts = await commandJson(exec, options.doctlPath, [
        "monitoring",
        "uptime",
        "alert",
        "list",
        id,
        "--output",
        "json",
      ]);
      uptimeAlertsByCheckId[id] = alerts;
    } catch (error) {
      uptimeAlertsByCheckId[id] = { error: describeDoctlFailure(error), alerts: [] };
    }
  }

  const databases = await collect("databases", ["databases", "list", "--output", "json"]);
  const databaseBackups = [];
  for (const database of databases.filter((candidate) =>
    databaseBackupManagedName(readField(candidate, "name", "Name")),
  )) {
    const clusterId = readField(database, "id", "ID");
    const clusterName = readField(database, "name", "Name") ?? "";
    if (!clusterId) {
      continue;
    }
    const collectionName = `databaseBackups:${clusterName}`;
    const backups = await collect(collectionName, ["databases", "backups", clusterId, "--output", "json"]);
    databaseBackups.push({
      clusterId,
      clusterName,
      environment: classifyEnvironment(clusterName),
      terraformRoot: databaseTerraformRoot(clusterName),
      collection: collectionName,
      collectionStatus: collections[collectionName]?.status ?? "unknown",
      backups,
    });
  }

  return {
    collections,
    errors,
    snapshot: {
      apps: mergeAppDetails(apps, appDetails),
      databases,
      databaseBackups,
      registryTags: await collect("registryTags", [
        "registry",
        "repository",
        "list-tags",
        options.repository,
        "--output",
        "json",
      ]),
      droplets: await collect("droplets", ["compute", "droplet", "list", "--output", "json"]),
      volumes: await collect("volumes", ["compute", "volume", "list", "--output", "json"]),
      uptimeChecks,
      uptimeAlertsByCheckId,
      cdns: await collect("cdns", ["compute", "cdn", "list", "--output", "json"]),
    },
  };
}

async function commandJson(exec, doctlPath, args) {
  const { stdout } = await exec(doctlPath, args, { maxBuffer: 50 * 1024 * 1024 });
  const parsed = JSON.parse(stdout || "[]");
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (Array.isArray(parsed.items)) {
    return parsed.items;
  }
  if (Array.isArray(parsed.droplets)) {
    return parsed.droplets;
  }
  if (Array.isArray(parsed.databases)) {
    return parsed.databases;
  }
  if (Array.isArray(parsed.backups)) {
    return parsed.backups;
  }
  if (Array.isArray(parsed.database_backups)) {
    return parsed.database_backups;
  }
  if (Array.isArray(parsed.uptime_checks)) {
    return parsed.uptime_checks;
  }
  return [parsed];
}

async function commandJsonObject(exec, doctlPath, args) {
  const records = await commandJson(exec, doctlPath, args);
  return records[0] ?? {};
}

function mergeAppDetails(apps, details) {
  const detailsById = new Map(details.map((app) => [readField(app, "id", "ID"), app]));
  return apps.map((app) => detailsById.get(readField(app, "id", "ID")) ?? app);
}

function summarizeApp(app) {
  const spec = app.spec ?? app.Spec ?? {};
  const name = readField(app, "name", "Name") ?? readField(spec, "name", "Name") ?? "";
  const components = [
    ...componentSummaries("service", spec.services ?? spec.Services ?? []),
    ...componentSummaries("worker", spec.workers ?? spec.Workers ?? []),
    ...componentSummaries("job", spec.jobs ?? spec.Jobs ?? []),
  ];
  return {
    id: readField(app, "id", "ID"),
    name,
    environment: classifyEnvironment(name),
    terraformRoot: null,
    classification: classifyApp(name),
    components,
  };
}

function componentSummaries(kind, components) {
  return components.map((component) => ({
    kind,
    name: readField(component, "name", "Name"),
    instanceCount: readNumberField(component, "instance_count", "InstanceCount", "instanceCount"),
    instanceSizeSlug: readField(component, "instance_size_slug", "InstanceSizeSlug", "instanceSizeSlug"),
    imageTag: readField(component.image ?? component.Image ?? {}, "tag", "Tag"),
    imageDigest: readField(component.image ?? component.Image ?? {}, "digest", "Digest"),
  }));
}

function summarizeDatabase(database, restorePointCutoff, heldByAuthority) {
  const name = readField(database, "name", "Name") ?? "";
  const createdAt = readField(database, "created_at", "createdAt", "CreatedAt");
  const restorePoint = name.startsWith(RESTORE_POINT_PREFIX);
  const restoreDrill = name.startsWith(RESTORE_DRILL_PREFIX);
  const oldRestorePoint =
    restorePoint &&
    Number.isFinite(Date.parse(createdAt ?? "")) &&
    Date.parse(createdAt) <= restorePointCutoff.getTime();
  const oldRestoreDrill =
    restoreDrill &&
    Number.isFinite(Date.parse(createdAt ?? "")) &&
    Date.parse(createdAt) <= restorePointCutoff.getTime();
  return {
    id: readField(database, "id", "ID"),
    name,
    status: readField(database, "status", "Status"),
    createdAt,
    size: readField(database, "size", "Size"),
    region: readField(database, "region", "Region"),
    environment: classifyEnvironment(name),
    terraformRoot: databaseTerraformRoot(name),
    classification:
      restorePoint || restoreDrill
        ? (oldRestorePoint || oldRestoreDrill) && !heldByAuthority
          ? "cleanup-candidate"
          : "operator-managed"
        : classifyDatabase(name),
    restorePoint,
    restoreDrill,
    oldRestorePoint,
    oldRestoreDrill,
    heldByAuthority,
  };
}

function summarizeDatabaseBackup(entry, checkedAt) {
  const backups = entry.backups
    .map((backup) => ({
      id: readField(backup, "id", "ID"),
      createdAt: readField(backup, "created_at", "createdAt", "CreatedAt"),
      sizeGib: readNumberField(backup, "size_gigabytes", "sizeGigabytes", "SizeGigabytes"),
    }))
    .filter((backup) => backup.createdAt);
  const newestBackup = backups
    .filter((backup) => Number.isFinite(Date.parse(backup.createdAt)))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const newestBackupAgeHours = newestBackup
    ? roundHours((checkedAt.getTime() - Date.parse(newestBackup.createdAt)) / (60 * 60 * 1000))
    : null;
  const policy = databaseBackupPolicy(entry.environment);
  const stale =
    entry.collectionStatus === "success" &&
    newestBackupAgeHours !== null &&
    policy?.maximumAgeHours !== undefined &&
    newestBackupAgeHours > policy.maximumAgeHours;
  const missing = entry.collectionStatus === "success" && backups.length === 0;
  return {
    clusterId: entry.clusterId,
    clusterName: entry.clusterName,
    environment: entry.environment,
    terraformRoot: entry.terraformRoot,
    collection: entry.collection,
    collectionStatus: entry.collectionStatus,
    backupCount: backups.length,
    newestBackupCreatedAt: newestBackup?.createdAt ?? null,
    newestBackupAgeHours,
    expectedMaximumAgeHours: policy?.maximumAgeHours ?? null,
    stale,
    missing,
  };
}

function summarizeRegistryTag(tag, registryCutoff) {
  const name = readField(tag, "tag", "name", "Tag", "Name") ?? "";
  const updatedAt = readField(tag, "updated_at", "updatedAt", "UpdatedAt", "created_at", "CreatedAt");
  const releaseTag = name.startsWith("release-");
  const old = Number.isFinite(Date.parse(updatedAt ?? "")) && Date.parse(updatedAt) <= registryCutoff.getTime();
  return {
    name,
    digest: readField(tag, "digest", "manifest_digest", "ManifestDigest"),
    updatedAt,
    terraformRoot: TERRAFORM_ROOTS.platform,
    classification: releaseTag ? "rollback-protected" : old ? "cleanup-eligible" : "retained",
    releaseTag,
    cleanupEligible: !releaseTag && old,
  };
}

function summarizeDroplet(droplet) {
  const name = readField(droplet, "name", "Name") ?? "";
  const environment = classifyEnvironment(name);
  const classification = classifyDroplet(name);
  const backupsEnabled = Boolean(droplet.backups ?? droplet.Backups ?? false);
  const policy = classification === "terraform-managed" ? observabilityPolicy(environment) : null;
  return {
    id: readField(droplet, "id", "ID"),
    name,
    status: readField(droplet, "status", "Status"),
    createdAt: readField(droplet, "created_at", "createdAt", "CreatedAt"),
    size: readField(droplet, "size_slug", "sizeSlug", "SizeSlug"),
    region: readNestedName(droplet.region ?? droplet.Region),
    backupsEnabled,
    environment,
    terraformRoot: observabilityName(name) ? TERRAFORM_ROOTS.observability : null,
    classification,
    observabilityBackupPosture: policy
      ? {
          expectedBackupsEnabled: policy.dropletBackupsExpected,
          actualBackupsEnabled: backupsEnabled,
          matchesPolicy: backupsEnabled === policy.dropletBackupsExpected,
        }
      : null,
  };
}

function summarizeVolume(volume) {
  const name = readField(volume, "name", "Name") ?? "";
  const environment = classifyEnvironment(name);
  const classification = classifyVolume(name);
  const policy = classification === "terraform-managed" ? observabilityPolicy(environment) : null;
  const sizeGib = readNumberField(volume, "size_gigabytes", "sizeGigabytes", "SizeGigabytes");
  return {
    id: readField(volume, "id", "ID"),
    name,
    sizeGib,
    createdAt: readField(volume, "created_at", "createdAt", "CreatedAt"),
    region: readNestedName(volume.region ?? volume.Region),
    environment,
    terraformRoot: observabilityVolumeName(name) ? TERRAFORM_ROOTS.observability : null,
    classification,
    observabilityDataPosture: policy
      ? {
          protection: policy.volumeProtection,
          acceptableTelemetryDataLossWindowHours: policy.acceptableTelemetryDataLossWindowHours,
          expectedMinimumSizeGib: policy.volumeSizeGibMinimum ?? null,
          expectedMaximumSizeGib: policy.volumeSizeGibMaximum ?? null,
          actualSizeGib: sizeGib,
        }
      : null,
  };
}

function summarizeUptimeCheck(check, alertsByCheckId) {
  const id = readField(check, "id", "ID") ?? "";
  const name = readField(check, "name", "Name") ?? "";
  const alerts = alertsByCheckId[id];
  const alertCount = Array.isArray(alerts) ? alerts.length : Array.isArray(alerts?.alerts) ? alerts.alerts.length : 0;
  return {
    id,
    name,
    target: readField(check, "target", "Target"),
    type: readField(check, "type", "Type"),
    enabled: check.enabled ?? check.Enabled ?? null,
    alertCount,
    alertCollectionError: alerts && !Array.isArray(alerts) ? alerts.error : null,
    terraformRoot:
      chaseSetsName(name) || chaseSetsName(readField(check, "target", "Target") ?? "")
        ? TERRAFORM_ROOTS.platform
        : null,
    classification:
      chaseSetsName(name) || chaseSetsName(readField(check, "target", "Target") ?? "")
        ? "terraform-managed"
        : "external",
  };
}

function summarizeCdn(cdn) {
  const endpoint = readField(cdn, "endpoint", "Endpoint") ?? "";
  const origin = readField(cdn, "origin", "Origin") ?? "";
  const customDomain = readField(cdn, "custom_domain", "customDomain", "CustomDomain");
  const chaseSetsCatalogAsset =
    origin.includes("chase-sets-") || endpoint.includes("chase-sets-") || chaseSetsName(customDomain ?? "");
  return {
    id: readField(cdn, "id", "ID"),
    origin,
    endpoint,
    customDomain,
    ttl: readNumberField(cdn, "ttl", "TTL"),
    terraformRoot: chaseSetsCatalogAsset ? TERRAFORM_ROOTS.catalogAssets : null,
    classification: chaseSetsCatalogAsset ? "terraform-managed" : "external",
  };
}

function appFindings(app) {
  if (app.classification === "retired-chase-sets-compute") {
    return [
      {
        severity: "warning",
        category: "retired-compute-present",
        resourceType: "app",
        resourceName: app.name,
        owner: "platform",
        terraformRoot: null,
        action: "Confirm the DOKS cutover is complete, then remove this retired DigitalOcean application resource.",
        evidence: { id: app.id, components: app.components.map((component) => component.name).filter(Boolean) },
      },
    ];
  }
  return [];
}

function databaseFindings(database) {
  if ((database.oldRestorePoint || database.oldRestoreDrill) && !database.heldByAuthority) {
    const drill = database.oldRestoreDrill;
    return [
      {
        severity: "warning",
        category: drill ? "restore-drill-retention" : "restore-point-retention",
        resourceType: "database",
        resourceName: database.name,
        owner: "ops",
        terraformRoot: null,
        action: drill
          ? "Delete the stale staging restore-drill fork or run restore-point cleanup with the cs-stg-drill- prefix before it accrues unnecessary cost."
          : "Run or inspect Platform Production Restore Point Cleanup before the fork accrues unnecessary cost.",
        evidence: { id: database.id, createdAt: database.createdAt },
      },
    ];
  }
  if (database.classification === "unknown-chase-sets") {
    return [
      unknownFinding(
        "database",
        database.name,
        "Database name starts with chase-sets but is not a platform cluster or restore point.",
      ),
    ];
  }
  if (database.classification === "forbidden-preview-managed-postgres") {
    return [
      {
        severity: "warning",
        category: "preview-managed-postgres-violation",
        resourceType: "database",
        resourceName: database.name,
        owner: "platform",
        terraformRoot: null,
        action:
          "Delete this PR preview managed database cluster; previews must use disposable in-cluster Postgres in their Kubernetes namespace.",
        evidence: { id: database.id, createdAt: database.createdAt },
      },
    ];
  }
  return [];
}

function databaseBackupFindings(backup) {
  if (backup.collectionStatus !== "success") {
    return [];
  }
  if (!backup.missing && !backup.stale) {
    return [];
  }
  return [
    {
      severity: "warning",
      category: "database-backup-health",
      resourceType: "database-backup",
      resourceName: backup.clusterName,
      owner: "ops",
      terraformRoot: backup.terraformRoot,
      action: backup.missing
        ? "Inspect DigitalOcean managed Postgres backup status before relying on PITR for this cluster."
        : "Inspect DigitalOcean managed Postgres backup status; the newest observed backup is older than the accepted threshold.",
      evidence: {
        clusterId: backup.clusterId,
        backupCount: backup.backupCount,
        newestBackupCreatedAt: backup.newestBackupCreatedAt,
        newestBackupAgeHours: backup.newestBackupAgeHours,
        expectedMaximumAgeHours: backup.expectedMaximumAgeHours,
      },
    },
  ];
}

function registryTagFindings(tag) {
  if (!tag.cleanupEligible) {
    return [];
  }
  return [
    {
      severity: "advisory",
      category: "registry-retention",
      resourceType: "registry-tag",
      resourceName: tag.name,
      owner: "ops",
      terraformRoot: tag.terraformRoot,
      action: "Registry cleanup may delete this tag if it is not explicitly protected by a release tag or digest.",
      evidence: { updatedAt: tag.updatedAt, digest: tag.digest },
    },
  ];
}

function dropletFindings(droplet) {
  if (droplet.classification === "repo-managed-disposable") {
    return [
      {
        severity: "advisory",
        category: "remote-dev-retention",
        resourceType: "droplet",
        resourceName: droplet.name,
        owner: "ops",
        terraformRoot: null,
        action: "Confirm remote-dev TTL tags are present and the developer environment is still in use.",
        evidence: { createdAt: droplet.createdAt, status: droplet.status },
      },
    ];
  }
  if (droplet.classification === "unknown-chase-sets") {
    return [
      unknownFinding("droplet", droplet.name, "Droplet name starts with chase-sets but is not an observability host."),
    ];
  }
  if (droplet.classification === "terraform-managed" && droplet.observabilityBackupPosture?.matchesPolicy === false) {
    return [
      {
        severity: "warning",
        category: "observability-backup-posture",
        resourceType: "droplet",
        resourceName: droplet.name,
        owner: "ops",
        terraformRoot: droplet.terraformRoot,
        action:
          "Disable shared observability Droplet backups; the default pre-launch posture keeps the reproducible host backup-free and protects operational value through telemetry retention and manual snapshots before maintenance.",
        evidence: {
          backupsEnabled: droplet.backupsEnabled,
          expectedBackupsEnabled: droplet.observabilityBackupPosture.expectedBackupsEnabled,
          size: droplet.size,
        },
      },
    ];
  }
  return [];
}

function volumeFindings(volume) {
  if (volume.classification === "repo-managed-disposable") {
    return [
      {
        severity: "advisory",
        category: "remote-dev-retention",
        resourceType: "volume",
        resourceName: volume.name,
        owner: "ops",
        terraformRoot: null,
        action: "Confirm this remote-dev volume still belongs to an active developer environment.",
        evidence: { createdAt: volume.createdAt, sizeGib: volume.sizeGib },
      },
    ];
  }
  if (volume.classification === "unknown-chase-sets") {
    return [
      unknownFinding(
        "volume",
        volume.name,
        "Volume name starts with chase-sets but is not an observability data volume.",
      ),
    ];
  }
  if (volume.classification === "terraform-managed") {
    const policy = volume.observabilityDataPosture;
    if (
      volume.environment === "shared" &&
      policy?.expectedMaximumSizeGib !== null &&
      volume.sizeGib !== null &&
      volume.sizeGib > policy.expectedMaximumSizeGib
    ) {
      return [
        {
          severity: "warning",
          category: "observability-volume-posture",
          resourceType: "volume",
          resourceName: volume.name,
          owner: "ops",
          terraformRoot: volume.terraformRoot,
          action:
            "Reduce shared pre-launch observability volume size or document the drill/incident that needs extra telemetry capacity.",
          evidence: {
            actualSizeGib: volume.sizeGib,
            expectedMaximumSizeGib: policy.expectedMaximumSizeGib,
            protection: policy.protection,
          },
        },
      ];
    }
    if (
      volume.environment === "shared" &&
      policy?.expectedMinimumSizeGib !== null &&
      volume.sizeGib !== null &&
      volume.sizeGib < policy.expectedMinimumSizeGib
    ) {
      return [
        {
          severity: "warning",
          category: "observability-volume-posture",
          resourceType: "volume",
          resourceName: volume.name,
          owner: "ops",
          terraformRoot: volume.terraformRoot,
          action:
            "Increase shared pre-launch observability volume size or record the accepted short-retention posture before relying on this host for incident review.",
          evidence: {
            actualSizeGib: volume.sizeGib,
            expectedMinimumSizeGib: policy.expectedMinimumSizeGib,
            protection: policy.protection,
          },
        },
      ];
    }
  }
  return [];
}

function uptimeCheckFindings(check) {
  if (check.classification === "terraform-managed" && check.alertCount === 0) {
    return [
      {
        severity: "advisory",
        category: "uptime-alerts",
        resourceType: "uptime-check",
        resourceName: check.name,
        owner: "ops",
        terraformRoot: check.terraformRoot,
        action: "Confirm the GitHub environment has alert emails configured if this target should page operators.",
        evidence: { target: check.target, alertCollectionError: check.alertCollectionError },
      },
    ];
  }
  return [];
}

function cdnFindings(cdn) {
  if (cdn.classification === "external") {
    return [];
  }
  if (!cdn.customDomain) {
    return [
      {
        severity: "advisory",
        category: "catalog-assets-cdn",
        resourceType: "cdn",
        resourceName: cdn.endpoint,
        owner: "catalog",
        terraformRoot: cdn.terraformRoot,
        action: "Confirm the CDN custom domain is configured for catalog asset delivery.",
        evidence: { origin: cdn.origin },
      },
    ];
  }
  return [];
}

function collectionErrorFinding(error) {
  return {
    severity: "warning",
    category: "collection",
    resourceType: "doctl",
    resourceName: error.collection,
    owner: "ops",
    terraformRoot: null,
    action: "Inspect the workflow log and doctl token permissions for this read-only collection.",
    evidence: { command: error.command, error: error.error },
  };
}

function unknownFinding(resourceType, resourceName, reason) {
  return {
    severity: "warning",
    category: "unknown-chase-sets-resource",
    resourceType,
    resourceName,
    owner: "ops",
    terraformRoot: null,
    action: "Map this resource to a Terraform root or create a targeted cleanup issue after operator review.",
    evidence: { reason },
  };
}

function summarizeDigest(input) {
  const resources = [
    ...input.apps,
    ...input.databases,
    ...input.databaseBackups,
    ...input.registryTags,
    ...input.droplets,
    ...input.volumes,
    ...input.uptimeChecks,
    ...input.cdns,
  ];
  return {
    observedResources: resources.length,
    terraformManagedResources: resources.filter((resource) => resource.classification === "terraform-managed").length,
    unknownChaseSetsResources: resources.filter((resource) => resource.classification === "unknown-chase-sets").length,
    cleanupCandidates:
      input.databases.filter(
        (database) => (database.oldRestorePoint || database.oldRestoreDrill) && !database.heldByAuthority,
      ).length + input.registryTags.filter((tag) => tag.cleanupEligible).length,
    heldRestorePoints: input.databases.filter((database) => database.heldByAuthority).length,
    databaseBackups: {
      observedClusters: input.databaseBackups.length,
      staleClusters: input.databaseBackups.filter((backup) => backup.stale).length,
      missingClusters: input.databaseBackups.filter((backup) => backup.missing).length,
      newestBackupAgeHoursByCluster: Object.fromEntries(
        input.databaseBackups.map((backup) => [backup.clusterName, backup.newestBackupAgeHours]),
      ),
    },
    advisoryFindings: input.findings.filter((finding) => finding.severity === "advisory").length,
    warningFindings: input.findings.filter((finding) => finding.severity === "warning").length,
    collectionErrors: input.collectionErrors.length,
  };
}

function resolveRestorePointHoldAuthority(tokens, databases) {
  if (tokens.length === 0) {
    return {
      heldDatabaseIndexes: new Set(),
      policy: restorePointHoldPolicy("absent", 0, 0, 0, null),
      finding: null,
    };
  }

  const tokenMatches = tokens.map((token, index) => {
    const matchingDatabaseIndexes = [];
    for (const [databaseIndex, database] of databases.entries()) {
      const id = readField(database, "id", "ID");
      const name = readField(database, "name", "Name");
      if (id === token || name === token) {
        matchingDatabaseIndexes.push(databaseIndex);
      }
    }
    const wellFormed =
      CANONICAL_DATABASE_ID.test(token) ||
      token.startsWith(RESTORE_POINT_PREFIX) ||
      token.startsWith(RESTORE_DRILL_PREFIX);
    return {
      token,
      index: index + 1,
      matchingDatabaseIndexes,
      refused: !wellFormed || matchingDatabaseIndexes.length > 1,
    };
  });
  const refusedTokens = tokenMatches.filter((entry) => entry.refused);

  if (refusedTokens.length > 0) {
    return {
      heldDatabaseIndexes: new Set(),
      policy: restorePointHoldPolicy("refused", tokens.length, 0, 0, null),
      finding: {
        severity: "warning",
        category: "restore-point-hold-authority-invalid",
        resourceType: "hold-authority",
        resourceName: RESTORE_POINT_HOLD_AUTHORITY_ALIAS,
        owner: "ops",
        terraformRoot: null,
        action:
          "Inspect the production restore-point cleanup hold authority and correct every malformed or ambiguous entry; no holds were applied.",
        evidence: {
          offendingTokens: refusedTokens.map(({ index, token }) => ({
            index,
            sha256Prefix: sha256(token).slice(0, 8),
          })),
        },
      },
    };
  }

  const heldDatabaseIndexes = new Set(tokenMatches.flatMap((entry) => entry.matchingDatabaseIndexes));
  const appliedCount = tokenMatches.filter((entry) => entry.matchingDatabaseIndexes.length === 1).length;
  return {
    heldDatabaseIndexes,
    policy: restorePointHoldPolicy(
      "applied",
      tokens.length,
      appliedCount,
      tokens.length - appliedCount,
      sha256(JSON.stringify(tokens)),
    ),
    finding: null,
  };
}

function restorePointHoldPolicy(status, tokenCount, appliedCount, unmatchedCount, effectiveTokenSetSha256) {
  return {
    status,
    tokenCount,
    appliedCount,
    unmatchedCount,
    effectiveTokenSetSha256,
  };
}

function parseHoldNames(values) {
  return Array.from(
    new Set(
      values
        .filter(isNonEmptyString)
        .flatMap((value) => value.split(/[,\n]/g))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function classifyApp(name) {
  return chaseSetsName(name) ? "retired-chase-sets-compute" : "external";
}

function classifyDatabase(name) {
  if (name.startsWith(RESTORE_DRILL_PREFIX)) {
    return "operator-managed";
  }
  if (/^chase-sets-pr-\d+-postgres$/.test(name)) {
    return "forbidden-preview-managed-postgres";
  }
  if (["chase-sets-postgres", "chase-sets-staging-postgres"].includes(name)) {
    return "terraform-managed";
  }
  return chaseSetsName(name) ? "unknown-chase-sets" : "external";
}

function databaseTerraformRoot(name) {
  return classifyDatabase(name) === "terraform-managed" ? TERRAFORM_ROOTS.platform : null;
}

function databaseBackupManagedName(name) {
  return ["chase-sets-postgres", "chase-sets-staging-postgres"].includes(name);
}

function classifyEnvironment(name) {
  if (name === "chase-sets-observability" || name === "chase-sets-observability-data") {
    return "shared";
  }
  if (name.startsWith(RESTORE_DRILL_PREFIX)) {
    return "staging";
  }
  if (/^chase-sets-pr-\d+/.test(name)) {
    return "preview";
  }
  if (name.includes("staging")) {
    return "staging";
  }
  if (name.startsWith("chase-sets")) {
    return "production";
  }
  return null;
}

function observabilityName(name) {
  return name === "chase-sets-observability";
}

function observabilityVolumeName(name) {
  return name === "chase-sets-observability-data";
}

function observabilityPolicy(environment) {
  return OBSERVABILITY_POLICIES[environment] ?? null;
}

function databaseBackupPolicy(environment) {
  return DATABASE_BACKUP_POLICIES[environment] ?? null;
}

function remoteDevName(name) {
  return /^chase-sets-dev-[a-z0-9-]+/.test(name);
}

function classifyDroplet(name) {
  if (observabilityName(name)) {
    return "terraform-managed";
  }
  if (remoteDevName(name)) {
    return "repo-managed-disposable";
  }
  return chaseSetsName(name) ? "unknown-chase-sets" : "external";
}

function classifyVolume(name) {
  if (observabilityVolumeName(name)) {
    return "terraform-managed";
  }
  if (remoteDevName(name)) {
    return "repo-managed-disposable";
  }
  return chaseSetsName(name) ? "unknown-chase-sets" : "external";
}

function chaseSetsName(name) {
  return typeof name === "string" && name.startsWith("chase-sets");
}

function readField(record, ...names) {
  for (const name of names) {
    const value = name.includes(".")
      ? name.split(".").reduce((current, part) => current?.[part], record)
      : record?.[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return null;
}

function readNumberField(record, ...names) {
  const value = readField(record, ...names);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readNestedName(value) {
  if (typeof value === "string") {
    return value;
  }
  return readField(value, "slug", "Slug", "name", "Name");
}

function describeDoctlFailure(error) {
  const details = ["doctl read-only collection failed."];
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

function parseNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number.`);
  }
  return parsed;
}

function roundHours(value) {
  return Math.max(0, Math.round(value * 100) / 100);
}

async function main(argv, env = process.env) {
  try {
    const result = await runDigitalOceanDriftDigest(parseDigitalOceanDriftDigestArgs(argv, env));
    console.log(JSON.stringify(result.record, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
