#!/usr/bin/env node
// CI-safe push-wake capacity evidence.
//
// Reads checked-in Terraform and registry sources only. It does not contact
// DigitalOcean, databases, staging, production, or secret-backed services.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { join, resolve } from "node:path";
import { readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import {
  doksStagingApiOverrides,
  doksStagingWorkerAutoscaling,
  doksStagingWorkerEnvOverrides,
} from "./render-platform-helm-values.mjs";

export const PUSH_WAKE_CAPACITY_EVIDENCE_VERSION = "push-wake-capacity-evidence/v1";

const DEFAULT_OUT_PATH = "artifacts/release-health/push-wake-capacity-evidence.json";
const PLATFORM_LOCALS_PATH = "infrastructure/digitalocean/platform/locals.tf";
const PLATFORM_VARIABLES_PATH = "infrastructure/digitalocean/platform/variables.tf";
const PLATFORM_RUNTIME_VALUES_PATH = "infrastructure/helm/platform/runtime-values.json";
// Registry entries live one module per source context under this directory;
// the sibling `source-context-wake-registry.ts` is only the static aggregate
// and holds no entry literals to parse.
const SOURCE_CONTEXT_WAKE_REGISTRY_SHARD_DIR = "infrastructure/platform-runtime/source-context-wake-registry";
const PLATFORM_API_DATABASE_POOLS_PATH = "deployables/platform-api/src/database-pools.ts";
/**
 * The only exception to the 80% rolling-deploy trigger: staging may exceed it
 * by the Auth Pending Registration lock pool's direct backends alone. Non-lock
 * rolling demand stays at or under the trigger, and every phase under the limit.
 */
export const AUTH_PENDING_REGISTRATION_LOCK_ALLOWANCE = Object.freeze({
  name: "Auth pending-registration direct locks",
  environment: "staging",
  maxLockBackends: 8,
  maxNonLockRolling: 75,
  maxRollingTotal: 82,
});
const CLUSTER_CONNECTION_LIMITS = Object.freeze({
  "db-s-1vcpu-1gb": 19,
  "db-s-1vcpu-2gb": 44,
  "db-s-2vcpu-4gb": 94,
  "db-s-4vcpu-8gb": 194,
});
const CONNECTION_BUDGET_UPGRADE_TRIGGER_PERCENT = 80;

function runtimeEnvValue(component, name) {
  const value = component.env.find((entry) => entry.name === name)?.value;
  if (value === undefined) {
    throw new Error(`Runtime component '${component}' is missing '${name}'.`);
  }
  return Number(value);
}

/**
 * Reads the per-process cap of the Pending Registration lock pool from its
 * factory, and only when the factory applies it after every pool override.
 * Anything else is unverified (NaN).
 */
export function readPendingRegistrationLockPoolMax(source) {
  const cap = Number(source.match(/^export const PENDING_REGISTRATION_LOCK_POOL_MAX = (\d+);$/m)?.[1]);
  const appliedAfterOverrides =
    source.includes("createPgPool(lockUrl, pendingRegistrationLockPoolOptions(config.pool))") &&
    source.includes("return { ...PLATFORM_API_DEFAULT_POOL, ...defined, max: PENDING_REGISTRATION_LOCK_POOL_MAX };");
  return Number.isInteger(cap) && cap > 0 && appliedAfterOverrides ? cap : NaN;
}

export function parsePushWakeCapacityArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? env.PUSH_WAKE_CAPACITY_OUT ?? DEFAULT_OUT_PATH,
    format: readOption(argv, "--format") ?? env.PUSH_WAKE_CAPACITY_FORMAT ?? "json",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    repoRoot: readOption(argv, "--repo-root") ?? process.cwd(),
  };
}

export function loadPushWakeCapacityInputs(repoRoot = process.cwd()) {
  const localsSource = readFileSync(resolve(repoRoot, PLATFORM_LOCALS_PATH), "utf8");
  const variablesSource = readFileSync(resolve(repoRoot, PLATFORM_VARIABLES_PATH), "utf8");
  const runtimeValues = JSON.parse(readFileSync(resolve(repoRoot, PLATFORM_RUNTIME_VALUES_PATH), "utf8"));
  const apiDatabasePoolsSource = readFileSync(resolve(repoRoot, PLATFORM_API_DATABASE_POOLS_PATH), "utf8");
  const registryShardSources = readSourceContextWakeRegistryShards(
    resolve(repoRoot, SOURCE_CONTEXT_WAKE_REGISTRY_SHARD_DIR),
  );

  const platformContextNames = extractStringList(localsSource, "platform_context_names");
  const directListenerContexts = extractStringList(localsSource, "worker_listener_source_contexts");
  const apiWaiterContexts = extractStringList(localsSource, "api_waiter_contexts");
  const stagingPoolOverrides = extractNumberMap(localsSource, "staging_context_database_connection_pool_sizes");
  const productionPoolOverrides = extractNumberMap(
    localsSource,
    "production_context_database_connection_pool_size_overrides",
  );
  const api = runtimeValues.components["platform-api"];
  const worker = runtimeValues.components["platform-worker"];
  const bootstrap = runtimeValues.components["platform-bootstrap"];
  const registryEntries = registryShardSources.flatMap((shardSource) =>
    parseSourceContextWakeRegistryEntries(shardSource),
  );
  if (registryEntries.length === 0) {
    throw new Error(`No source-context wake registry entries found under '${SOURCE_CONTEXT_WAKE_REGISTRY_SHARD_DIR}'.`);
  }

  return {
    sourcePaths: {
      platformLocals: PLATFORM_LOCALS_PATH,
      platformVariables: PLATFORM_VARIABLES_PATH,
      platformRuntimeValues: PLATFORM_RUNTIME_VALUES_PATH,
      platformApiDatabasePools: PLATFORM_API_DATABASE_POOLS_PATH,
      sourceContextWakeRegistry: SOURCE_CONTEXT_WAKE_REGISTRY_SHARD_DIR,
    },
    platformContextNames,
    directListenerContexts,
    apiWaiterContexts,
    activeRelayContexts: registryEntries
      .filter((entry) => entry.relayFanOutEnabled)
      .map((entry) => entry.sourceContextName),
    wave2Contexts: registryEntries
      .filter((entry) => entry.rolloutWave === "wave-2-commerce-dependencies")
      .map((entry) => entry.sourceContextName),
    stagingPoolOverrides,
    productionPoolOverrides,
    clusterConnectionLimits: CLUSTER_CONNECTION_LIMITS,
    defaults: {
      apiDatabasePoolMax: runtimeEnvValue(api, "DATABASE_POOL_MAX"),
      apiComponentCount: 1,
      authPendingRegistrationLockPoolMax: readPendingRegistrationLockPoolMax(apiDatabasePoolsSource),
      bootstrapDatabasePoolMax: runtimeEnvValue(bootstrap, "DATABASE_POOL_MAX"),
      workerComponentCount: 1,
      stagingWorkerDatabasePoolMax: Number(doksStagingWorkerEnvOverrides.DATABASE_POOL_MAX),
      productionWorkerDatabasePoolMax: runtimeEnvValue(worker, "DATABASE_POOL_MAX"),
      doksStagingWorkerDatabasePoolMax: Number(doksStagingWorkerEnvOverrides.DATABASE_POOL_MAX),
      doksStagingProjectionMaxConcurrentRunners: Number(
        doksStagingWorkerEnvOverrides.WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS ?? 1,
      ),
      doksStagingWakeMaxConcurrentRunners: Number(doksStagingWorkerEnvOverrides.WORKER_WAKE_MAX_CONCURRENT_RUNNERS),
      doksStagingWakeStandardLaneRunnerCount: Number(
        doksStagingWorkerEnvOverrides.WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT,
      ),
      stagingWorkerInstances: doksStagingWorkerAutoscaling.minReplicaCount,
      productionWorkerInstances: worker.replicas,
      stagingApiInstances: doksStagingApiOverrides.replicas,
      productionApiInstances: api.replicas,
      stagingDatabaseSize: extractVariableDefault(variablesSource, "staging_database_size"),
      productionDatabaseSize: extractVariableDefault(variablesSource, "database_size"),
      connectionBudgetUpgradeTriggerPercent: CONNECTION_BUDGET_UPGRADE_TRIGGER_PERCENT,
    },
  };
}

export function buildPushWakeCapacityEvidence(input) {
  const directListenerSet = new Set(input.directListenerContexts);
  const activeRelaySet = new Set(input.activeRelayContexts);
  const wave2Set = new Set(input.wave2Contexts);
  const missingActiveDirectListenerContexts = input.activeRelayContexts.filter(
    (contextName) => !directListenerSet.has(contextName),
  );
  const missingWave2DirectListenerContexts = input.wave2Contexts.filter(
    (contextName) => !directListenerSet.has(contextName),
  );

  const stagingPgbouncerAllocation = input.platformContextNames.reduce(
    (sum, contextName) => sum + (input.stagingPoolOverrides[contextName] ?? 1),
    0,
  );
  const productionPgbouncerAllocation = input.platformContextNames.reduce(
    (sum, contextName) => sum + (input.productionPoolOverrides[contextName] ?? 1),
    0,
  );
  const lockPoolMax = input.defaults.authPendingRegistrationLockPoolMax;
  if (!Number.isInteger(lockPoolMax) || lockPoolMax < 1) {
    throw new Error(
      `Auth pending-registration lock pool cap is unverified; ${PLATFORM_API_DATABASE_POOLS_PATH} must apply PENDING_REGISTRATION_LOCK_POOL_MAX after every pool override.`,
    );
  }
  // Each API process holds up to the lock pool cap in direct Auth backends; a
  // rolling deploy runs two API generations.
  const lockDemand = (apiInstances) => ({
    poolMax: lockPoolMax,
    apiInstances,
    steadyState: lockPoolMax * input.defaults.apiComponentCount * apiInstances,
    deployOverlap: 2 * lockPoolMax * input.defaults.apiComponentCount * apiInstances,
  });
  const stagingLocks = lockDemand(input.defaults.stagingApiInstances);
  const productionLocks = lockDemand(input.defaults.productionApiInstances);

  const staging = buildEnvironmentBudget({
    environment: "staging",
    databaseSize: input.defaults.stagingDatabaseSize,
    clusterConnectionLimits: input.clusterConnectionLimits,
    upgradeTriggerPercent: input.defaults.connectionBudgetUpgradeTriggerPercent,
    pgbouncerServerBackendAllocation: stagingPgbouncerAllocation,
    directListenerCount: input.directListenerContexts.length,
    apiWaiterListenerDemand:
      input.apiWaiterContexts.length * input.defaults.apiComponentCount * input.defaults.stagingApiInstances,
    bootstrapDemand: 0, // Pre-upgrade bootstrap is a separate quiesced phase, not rolling demand.
    directAppBackendDemand: 0,
    productionLikeDirectBindings: false,
    authPendingRegistrationLocks: stagingLocks,
    allowance: AUTH_PENDING_REGISTRATION_LOCK_ALLOWANCE,
  });

  const productionApiPoolDemand =
    input.defaults.apiDatabasePoolMax * input.defaults.apiComponentCount * input.defaults.productionApiInstances;
  const productionWorkerPoolDemand =
    input.defaults.productionWorkerDatabasePoolMax *
    input.defaults.workerComponentCount *
    input.defaults.productionWorkerInstances;
  // #4655 converged production query traffic onto managed transaction pools, so
  // production now uses the same PgBouncer server-side allocation branch as
  // staging: app pool maxima are client-side only, and the summed production
  // pool sizes are the cluster-backend footprint of pooled query traffic.
  const production = buildEnvironmentBudget({
    environment: "production",
    databaseSize: input.defaults.productionDatabaseSize,
    clusterConnectionLimits: input.clusterConnectionLimits,
    upgradeTriggerPercent: input.defaults.connectionBudgetUpgradeTriggerPercent,
    pgbouncerServerBackendAllocation: productionPgbouncerAllocation,
    directListenerCount: input.directListenerContexts.length,
    apiWaiterListenerDemand:
      input.apiWaiterContexts.length * input.defaults.apiComponentCount * input.defaults.productionApiInstances,
    bootstrapDemand: 0,
    directAppBackendDemand: 0,
    productionLikeDirectBindings: false,
    authPendingRegistrationLocks: productionLocks,
    allowance: null,
  });
  const doksStaging = {
    ...buildEnvironmentBudget({
      environment: "staging-doks",
      databaseSize: input.defaults.stagingDatabaseSize,
      clusterConnectionLimits: input.clusterConnectionLimits,
      upgradeTriggerPercent: input.defaults.connectionBudgetUpgradeTriggerPercent,
      pgbouncerServerBackendAllocation: stagingPgbouncerAllocation,
      directListenerCount: input.directListenerContexts.length,
      apiWaiterListenerDemand:
        input.apiWaiterContexts.length * input.defaults.apiComponentCount * input.defaults.stagingApiInstances,
      bootstrapDemand: 0,
      directAppBackendDemand: 0,
      productionLikeDirectBindings: false,
      authPendingRegistrationLocks: stagingLocks,
      allowance: AUTH_PENDING_REGISTRATION_LOCK_ALLOWANCE,
    }),
    queryConnectionMode: "transaction-pool",
    queryConnectionSource:
      "platform-production.yml exports staging DATABASE_URL_* and PLATFORM_CONTROL_DATABASE_URL from digitalocean_database_connection_pool.contexts; waiter, listener, and bootstrap keys remain direct.",
    apiPoolDemand:
      input.defaults.apiDatabasePoolMax * input.defaults.apiComponentCount * input.defaults.stagingApiInstances,
    workerPoolDemand: input.defaults.doksStagingWorkerDatabasePoolMax * input.defaults.workerComponentCount,
    workerCapacity: {
      databasePoolMax: input.defaults.doksStagingWorkerDatabasePoolMax,
      previousDatabasePoolMax: input.defaults.productionWorkerDatabasePoolMax,
      configuredRunnerConcurrency:
        input.defaults.doksStagingProjectionMaxConcurrentRunners +
        1 +
        1 +
        1 +
        1 +
        1 +
        input.defaults.doksStagingWakeMaxConcurrentRunners,
      wakeMaxConcurrentRunners: input.defaults.doksStagingWakeMaxConcurrentRunners,
      wakeStandardLaneRunnerCount: input.defaults.doksStagingWakeStandardLaneRunnerCount,
      steadyStatePoolDelta: 0,
      deployOverlapPoolDelta: 0,
    },
  };

  const activeDirectListenerExpansion = evaluateExpansion({
    currentOverlapDemand: production.deployOverlap.total,
    limit: production.limit,
    additionalListenerContexts: missingActiveDirectListenerContexts,
    clusterConnectionLimits: input.clusterConnectionLimits,
  });
  const wave2DirectListenerExpansion = evaluateExpansion({
    currentOverlapDemand: production.deployOverlap.total,
    limit: production.limit,
    additionalListenerContexts: missingWave2DirectListenerContexts,
    clusterConnectionLimits: input.clusterConnectionLimits,
  });

  const recommendedDatabaseSize =
    wave2DirectListenerExpansion.requiredDatabaseSize ?? activeDirectListenerExpansion.requiredDatabaseSize;

  if (
    !wave2DirectListenerExpansion.fitsCurrentTier &&
    !recommendedDatabaseSize &&
    wave2DirectListenerExpansion.additionalListenerContextCount > 0
  ) {
    throw new Error("No budgeted database tier can fit the direct listener expansion.");
  }

  return {
    schemaVersion: PUSH_WAKE_CAPACITY_EVIDENCE_VERSION,
    checkedAt: input.checkedAt,
    issueNumbers: [1363, 1364, 4633, 4762],
    sourcePaths: input.sourcePaths,
    terraformDefaults: {
      platformContextCount: input.platformContextNames.length,
      directListenerContexts: input.directListenerContexts,
      apiWaiterContexts: input.apiWaiterContexts,
      activeRegistryRelayContexts: input.activeRelayContexts,
      wave2Contexts: input.wave2Contexts,
      apiDatabasePoolMax: input.defaults.apiDatabasePoolMax,
      apiComponentCount: input.defaults.apiComponentCount,
      productionWorkerDatabasePoolMax: input.defaults.productionWorkerDatabasePoolMax,
      doksStagingWorkerDatabasePoolMax: input.defaults.doksStagingWorkerDatabasePoolMax,
      workerComponentCount: input.defaults.workerComponentCount,
      bootstrapDatabasePoolMax: input.defaults.bootstrapDatabasePoolMax,
      clusterConnectionLimits: input.clusterConnectionLimits,
      connectionBudgetUpgradeTriggerPercent: input.defaults.connectionBudgetUpgradeTriggerPercent,
    },
    environments: {
      staging,
      doksStaging,
      production: {
        ...production,
        apiPoolDemand: productionApiPoolDemand,
        workerPoolDemand: productionWorkerPoolDemand,
      },
    },
    registryToInfrastructureGap: {
      activeRelayContextsWithoutDirectListenerUrls: missingActiveDirectListenerContexts,
      wave2ContextsWithoutDirectListenerUrls: missingWave2DirectListenerContexts,
      note: "Registry relay fan-out can run catch-up passes without direct LISTEN URLs; production push enablement needs budgeted direct listener URLs before relying on notification wake latency.",
    },
    expansionDecision: {
      posture: wave2DirectListenerExpansion.fitsCurrentTier
        ? "wave-2-direct-listeners-fit-current-tier"
        : "hold-wave-2-direct-listeners-until-tier-or-overlap-decision",
      productionAdditionalDirectListenerContextsAtCurrentTier:
        production.deployOverlap.additionalDirectListenerContextsAtCurrentTier,
      activeRegistryDirectListenerExpansion: activeDirectListenerExpansion,
      wave2DirectListenerExpansion,
      recommendedDatabaseSize,
      alternatives: [
        "Scale production database_size to the recommended budgeted tier before direct wave-2 listener URLs are added.",
        "Keep production direct LISTEN sources at wave 1 and let additional active registry sources rely on catch-up until a tier decision lands.",
        "Relax the rolling-deploy overlap model only with deployed evidence that old/new proof-mode component families and listener generations cannot overlap at the same backend demand.",
        "Reduce API/worker pool maxima or production instance counts only if the route and worker capacity evidence proves that does not create a freshness or availability regression.",
      ],
    },
    volumeLoadProofPosture: {
      posture: "not-proven-by-this-ci-evidence",
      note: "This record proves the checked-in connection budget and listener expansion decision only. Production-like volume load proof for #1363 still requires live load evidence or a dedicated load environment.",
    },
    redaction: {
      secrets: "not-read",
      databaseUrls: "not-read",
      liveEnvironmentAccess: "not-used",
    },
  };
}

export function renderPushWakeCapacityMarkdown(evidence) {
  const production = evidence.environments.production;
  const doksStaging = evidence.environments.doksStaging;
  const wave2 = evidence.expansionDecision.wave2DirectListenerExpansion;
  const active = evidence.expansionDecision.activeRegistryDirectListenerExpansion;
  const posture = (label, budget) =>
    `- ${label}: ${budget.total}/${budget.limit} (base ${budget.base} + ${budget.locks} Auth pending-registration direct locks; headroom ${budget.headroom})`;
  return [
    "# Push-Wake Capacity Evidence",
    "",
    `Schema: \`${evidence.schemaVersion}\``,
    `Checked at: ${evidence.checkedAt}`,
    `Issues: ${evidence.issueNumbers.map((issue) => `#${issue}`).join(", ")}`,
    "",
    "## Production Connection Budget",
    "",
    `- Database tier: \`${production.databaseSize}\` (${production.limit} backend budget)`,
    posture("Steady state", production.steadyState),
    posture("Rolling-deploy overlap", production.deployOverlap),
    `- Tier-upgrade trigger: ${production.upgradeTrigger}/${production.limit} (${production.upgradeTriggerPercent}%; headroom ${production.deployOverlap.upgradeTriggerHeadroom}, no allowance)`,
    `- Additional direct listener contexts that fit current tier during overlap: ${production.deployOverlap.additionalDirectListenerContextsAtCurrentTier}`,
    `- Additional direct listener contexts before upgrade trigger: ${production.deployOverlap.additionalDirectListenerContextsBeforeUpgradeTrigger}`,
    "",
    "## DOKS Staging Connection Budget",
    "",
    `- Query connection mode: \`${doksStaging.queryConnectionMode}\``,
    `- Worker pool: ${doksStaging.workerCapacity.previousDatabasePoolMax} -> ${doksStaging.workerCapacity.databasePoolMax}; wake max ${doksStaging.workerCapacity.wakeMaxConcurrentRunners}; standard lane ${doksStaging.workerCapacity.wakeStandardLaneRunnerCount}`,
    posture("Steady state", doksStaging.steadyState),
    posture("Rolling-deploy overlap", doksStaging.deployOverlap),
    `- Tier-upgrade trigger: ${doksStaging.upgradeTrigger}/${doksStaging.limit} (${doksStaging.upgradeTriggerPercent}%; non-lock headroom ${doksStaging.deployOverlap.upgradeTriggerHeadroom}, allowance \`${doksStaging.deployOverlap.allowance}\`)`,
    "",
    "## Listener Expansion Decision",
    "",
    `- Current direct listener contexts: ${evidence.terraformDefaults.directListenerContexts.join(", ")}`,
    `- Active registry relay contexts without direct listener URLs: ${active.additionalListenerContexts.join(", ") || "none"}`,
    `- Wave-2 contexts without direct listener URLs: ${wave2.additionalListenerContexts.join(", ") || "none"}`,
    `- Posture: **${evidence.expansionDecision.posture}**`,
    `- Recommended database size for wave-2 direct listeners: \`${evidence.expansionDecision.recommendedDatabaseSize ?? "current-tier"}\``,
    "",
    "## Scope",
    "",
    evidence.volumeLoadProofPosture.note,
    "",
  ].join("\n");
}

function buildEnvironmentBudget(input) {
  const limit = input.clusterConnectionLimits[input.databaseSize] ?? 0;
  const upgradeTrigger = Math.floor((limit * input.upgradeTriggerPercent) / 100);
  const steadyTotal = input.productionLikeDirectBindings
    ? input.directAppBackendDemand + input.directListenerCount + input.bootstrapDemand
    : input.pgbouncerServerBackendAllocation + input.directListenerCount + input.bootstrapDemand;
  const deployOverlapTotal = input.productionLikeDirectBindings
    ? 2 * input.directAppBackendDemand +
      2 * input.directListenerCount +
      2 * input.apiWaiterListenerDemand +
      input.bootstrapDemand
    : input.pgbouncerServerBackendAllocation +
      2 * input.directListenerCount +
      2 * input.apiWaiterListenerDemand +
      input.bootstrapDemand;
  const steadyTotalWithWaiters = steadyTotal + input.apiWaiterListenerDemand;
  const locks = input.authPendingRegistrationLocks;
  const allowance = input.allowance;
  const overlapTotal = deployOverlapTotal + locks.deployOverlap;
  // The named allowance covers only lock backends: listener growth must keep
  // non-lock demand under the trigger and the total under the allowance.
  const triggerRoom = allowance
    ? Math.min(upgradeTrigger - deployOverlapTotal, allowance.maxRollingTotal - overlapTotal)
    : upgradeTrigger - overlapTotal;

  return {
    environment: input.environment,
    databaseSize: input.databaseSize,
    limit,
    upgradeTriggerPercent: input.upgradeTriggerPercent,
    upgradeTrigger,
    pgbouncerServerBackendAllocation: input.pgbouncerServerBackendAllocation,
    directListenerCount: input.directListenerCount,
    apiWaiterListenerDemand: input.apiWaiterListenerDemand,
    bootstrapDemand: input.bootstrapDemand,
    authPendingRegistrationLocks: locks,
    steadyState: budgetPosture(steadyTotalWithWaiters, locks.steadyState, limit),
    deployOverlap: {
      ...budgetPosture(deployOverlapTotal, locks.deployOverlap, limit),
      upgradeTriggerHeadroom: upgradeTrigger - (allowance ? deployOverlapTotal : overlapTotal),
      allowance: allowance?.name ?? null,
      additionalDirectListenerContextsAtCurrentTier: Math.max(0, Math.floor((limit - overlapTotal) / 2)),
      additionalDirectListenerContextsBeforeUpgradeTrigger: Math.max(0, Math.floor(triggerRoom / 2)),
    },
  };
}

function budgetPosture(base, locks, limit) {
  const total = base + locks;
  return {
    base,
    locks,
    total,
    limit,
    headroom: limit - total,
    fits: total <= limit,
  };
}

function evaluateExpansion(input) {
  const additionalOverlapDemand = 2 * input.additionalListenerContexts.length;
  const expandedOverlapDemand = input.currentOverlapDemand + additionalOverlapDemand;
  const requiredDatabaseSize =
    expandedOverlapDemand <= input.limit
      ? null
      : (Object.entries(input.clusterConnectionLimits)
          .sort(([, left], [, right]) => left - right)
          .find(([, limit]) => expandedOverlapDemand <= limit)?.[0] ?? null);

  return {
    additionalListenerContexts: input.additionalListenerContexts,
    additionalListenerContextCount: input.additionalListenerContexts.length,
    additionalOverlapDemand,
    expandedOverlapDemand,
    fitsCurrentTier: expandedOverlapDemand <= input.limit,
    requiredDatabaseSize,
  };
}

export function readSourceContextWakeRegistryShards(directory) {
  return readdirSync(directory)
    .filter((fileName) => fileName.endsWith(".ts"))
    .sort()
    .map((fileName) => readFileSync(join(directory, fileName), "utf8"));
}

export function parseSourceContextWakeRegistryEntries(source) {
  return source
    .split(/registryEntry\(\{/)
    .slice(1)
    .map((chunk) => ({
      sourceContextName: extractStringProperty(chunk, "sourceContextName"),
      rolloutState: extractStringProperty(chunk, "rolloutState"),
      rolloutWave: extractStringProperty(chunk, "rolloutWave"),
      eventStoreWakeNotificationsEnabled: extractBooleanProperty(chunk, "eventStoreWakeNotifications"),
      relayFanOutEnabled: extractBooleanProperty(chunk, "relayFanOut"),
    }))
    .filter((entry) => entry.sourceContextName);
}

function extractStringList(source, localName) {
  const match = new RegExp(`${escapeRegExp(localName)}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (!match) {
    throw new Error(`Could not find Terraform string list local '${localName}'.`);
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function extractNumberMap(source, localName) {
  const match = new RegExp(`${escapeRegExp(localName)}\\s*=\\s*(?:merge\\([^{}]*,\\s*)?\\{([\\s\\S]*?)\\n\\s*\\}`).exec(
    source,
  );
  if (!match) {
    throw new Error(`Could not find Terraform number map local '${localName}'.`);
  }
  return Object.fromEntries(
    [...match[1].matchAll(/"?([A-Za-z0-9_-]+)"?\s+=\s+(\d+)/g)].map((entry) => [entry[1], Number(entry[2])]),
  );
}

function extractVariableDefault(source, variableName) {
  const match = new RegExp(`variable "${escapeRegExp(variableName)}" \\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!match) {
    throw new Error(`Could not find Terraform variable '${variableName}'.`);
  }
  const defaultMatch = /default\s+=\s+"([^"]+)"/.exec(match[1]);
  if (!defaultMatch) {
    throw new Error(`Could not find Terraform default for variable '${variableName}'.`);
  }
  return defaultMatch[1];
}

function extractStringProperty(source, propertyName) {
  return new RegExp(`${escapeRegExp(propertyName)}:\\s*"([^"]+)"`).exec(source)?.[1] ?? null;
}

function extractBooleanProperty(source, propertyName) {
  return new RegExp(`${escapeRegExp(propertyName)}:\\s*(true|false)`).exec(source)?.[1] === "true";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main(argv) {
  const options = parsePushWakeCapacityArgs(argv);
  if (!["json", "markdown"].includes(options.format)) {
    console.error("--format must be 'json' or 'markdown'.");
    return 2;
  }

  try {
    const input = loadPushWakeCapacityInputs(options.repoRoot);
    const evidence = buildPushWakeCapacityEvidence({ ...input, checkedAt: options.checkedAt });
    if (options.format === "markdown") {
      console.log(renderPushWakeCapacityMarkdown(evidence));
      return 0;
    }
    await writeJsonRecord(options.outPath, evidence);
    console.log(`Wrote push-wake capacity evidence to ${options.outPath}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
