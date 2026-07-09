#!/usr/bin/env node
// CI-safe push-wake capacity evidence for #1363/#1364/#4633.
//
// Reads checked-in Terraform and registry sources only. It does not contact
// DigitalOcean, databases, staging, production, or secret-backed services.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { resolve } from "node:path";
import { readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { doksStagingWorkerEnvOverrides } from "./render-platform-helm-values.mjs";

export const PUSH_WAKE_CAPACITY_EVIDENCE_VERSION = "push-wake-capacity-evidence/v1";

const DEFAULT_OUT_PATH = "artifacts/release-health/push-wake-capacity-evidence.json";
const PLATFORM_LOCALS_PATH = "infrastructure/digitalocean/platform/locals.tf";
const PLATFORM_VARIABLES_PATH = "infrastructure/digitalocean/platform/variables.tf";
const SOURCE_CONTEXT_WAKE_REGISTRY_PATH = "infrastructure/platform-runtime/source-context-wake-registry.ts";

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
  const registrySource = readFileSync(resolve(repoRoot, SOURCE_CONTEXT_WAKE_REGISTRY_PATH), "utf8");

  const platformContextNames = extractStringList(localsSource, "platform_context_names");
  const directListenerContexts = extractStringList(localsSource, "worker_listener_source_contexts");
  const apiWaiterContexts = extractStringList(localsSource, "api_waiter_contexts");
  const stagingPoolOverrides = extractNumberMap(localsSource, "staging_context_database_connection_pool_sizes");
  const productionPoolOverrides = extractNumberMap(
    localsSource,
    "production_context_database_connection_pool_size_overrides",
  );
  const clusterConnectionLimits = extractNumberMap(localsSource, "cluster_connection_limits");
  const connectionBudgetUpgradeTriggerPercent = Number(
    extractNumericLocal(localsSource, "connection_budget_upgrade_trigger_percent"),
  );
  const registryEntries = parseSourceContextWakeRegistryEntries(registrySource);

  return {
    sourcePaths: {
      platformLocals: PLATFORM_LOCALS_PATH,
      platformVariables: PLATFORM_VARIABLES_PATH,
      sourceContextWakeRegistry: SOURCE_CONTEXT_WAKE_REGISTRY_PATH,
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
    clusterConnectionLimits,
    defaults: {
      apiDatabasePoolMax: Number(extractQuotedLocal(localsSource, "api_database_pool_max")),
      apiComponentCount: Number(extractNumericLocal(localsSource, "api_component_count")),
      bootstrapDatabasePoolMax: Number(extractQuotedLocal(localsSource, "bootstrap_database_pool_max")),
      workerComponentCount: Number(extractNumericLocal(localsSource, "worker_component_count")),
      stagingWorkerDatabasePoolMax: extractTernaryNumbers(localsSource, "worker_default_database_pool_max").trueValue,
      productionWorkerDatabasePoolMax: extractTernaryNumbers(localsSource, "worker_default_database_pool_max")
        .falseValue,
      doksStagingWorkerDatabasePoolMax: Number(doksStagingWorkerEnvOverrides.DATABASE_POOL_MAX),
      doksStagingProjectionMaxConcurrentRunners: Number(
        doksStagingWorkerEnvOverrides.WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS ?? 1,
      ),
      doksStagingWakeMaxConcurrentRunners: Number(doksStagingWorkerEnvOverrides.WORKER_WAKE_MAX_CONCURRENT_RUNNERS),
      doksStagingWakeStandardLaneRunnerCount: Number(
        doksStagingWorkerEnvOverrides.WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT,
      ),
      stagingWorkerInstances: extractTernaryNumbers(localsSource, "default_worker_instances").trueValue,
      productionWorkerInstances: extractTernaryNumbers(localsSource, "default_worker_instances").falseValue,
      stagingApiInstances: extractTernaryNumbers(localsSource, "api_instances").falseValue,
      productionApiInstances: extractTernaryNumbers(localsSource, "api_instances").trueValue,
      stagingDatabaseSize: extractVariableDefault(variablesSource, "staging_database_size"),
      productionDatabaseSize: extractVariableDefault(variablesSource, "database_size"),
      connectionBudgetUpgradeTriggerPercent,
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

  const staging = buildEnvironmentBudget({
    environment: "staging",
    databaseSize: input.defaults.stagingDatabaseSize,
    clusterConnectionLimits: input.clusterConnectionLimits,
    upgradeTriggerPercent: input.defaults.connectionBudgetUpgradeTriggerPercent,
    pgbouncerServerBackendAllocation: stagingPgbouncerAllocation,
    directListenerCount: input.directListenerContexts.length,
    apiWaiterListenerDemand:
      input.apiWaiterContexts.length * input.defaults.apiComponentCount * input.defaults.stagingApiInstances,
    bootstrapDemand: input.defaults.bootstrapDatabasePoolMax,
    directAppBackendDemand: 0,
    productionLikeDirectBindings: false,
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
    bootstrapDemand: input.defaults.bootstrapDatabasePoolMax,
    directAppBackendDemand: 0,
    productionLikeDirectBindings: false,
  });
  const doksStagingDirectAppBackendDemand =
    input.defaults.apiDatabasePoolMax * input.defaults.apiComponentCount * input.defaults.stagingApiInstances +
    input.defaults.doksStagingWorkerDatabasePoolMax * input.defaults.workerComponentCount;
  const doksStaging = {
    ...buildEnvironmentBudget({
      environment: "staging-doks",
      databaseSize: input.defaults.stagingDatabaseSize,
      clusterConnectionLimits: input.clusterConnectionLimits,
      upgradeTriggerPercent: input.defaults.connectionBudgetUpgradeTriggerPercent,
      pgbouncerServerBackendAllocation: 0,
      directListenerCount: input.directListenerContexts.length,
      apiWaiterListenerDemand:
        input.apiWaiterContexts.length * input.defaults.apiComponentCount * input.defaults.stagingApiInstances,
      bootstrapDemand: input.defaults.bootstrapDatabasePoolMax,
      directAppBackendDemand: doksStagingDirectAppBackendDemand,
      productionLikeDirectBindings: true,
    }),
    queryConnectionMode: "direct",
    queryConnectionSource:
      "platform-production.yml exports DOKS staging DATABASE_URL_* and PLATFORM_* URLs from digitalocean_database_user.contexts plus digitalocean_database_cluster.postgres host/port, not digitalocean_database_connection_pool.contexts.",
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
      steadyStatePoolDelta:
        input.defaults.doksStagingWorkerDatabasePoolMax - input.defaults.productionWorkerDatabasePoolMax,
      deployOverlapPoolDelta:
        2 * (input.defaults.doksStagingWorkerDatabasePoolMax - input.defaults.productionWorkerDatabasePoolMax),
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
    `- Steady state: ${production.steadyState.total}/${production.limit} (headroom ${production.steadyState.headroom})`,
    `- Rolling-deploy overlap: ${production.deployOverlap.total}/${production.limit} (headroom ${production.deployOverlap.headroom})`,
    `- Tier-upgrade trigger: ${production.upgradeTrigger}/${production.limit} (${production.upgradeTriggerPercent}%)`,
    `- Additional direct listener contexts that fit current tier during overlap: ${production.deployOverlap.additionalDirectListenerContextsAtCurrentTier}`,
    `- Additional direct listener contexts before upgrade trigger: ${production.deployOverlap.additionalDirectListenerContextsBeforeUpgradeTrigger}`,
    "",
    "## DOKS Staging Connection Budget",
    "",
    `- Query connection mode: \`${doksStaging.queryConnectionMode}\``,
    `- Worker pool: ${doksStaging.workerCapacity.previousDatabasePoolMax} -> ${doksStaging.workerCapacity.databasePoolMax}; wake max ${doksStaging.workerCapacity.wakeMaxConcurrentRunners}; standard lane ${doksStaging.workerCapacity.wakeStandardLaneRunnerCount}`,
    `- Steady state: ${doksStaging.steadyState.total}/${doksStaging.limit} (headroom ${doksStaging.steadyState.headroom})`,
    `- Rolling-deploy overlap: ${doksStaging.deployOverlap.total}/${doksStaging.limit} (headroom ${doksStaging.deployOverlap.headroom})`,
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
    steadyState: budgetPosture(steadyTotalWithWaiters, limit),
    deployOverlap: {
      ...budgetPosture(deployOverlapTotal, limit),
      additionalDirectListenerContextsAtCurrentTier: Math.max(0, Math.floor((limit - deployOverlapTotal) / 2)),
      additionalDirectListenerContextsBeforeUpgradeTrigger: Math.max(
        0,
        Math.floor((upgradeTrigger - deployOverlapTotal) / 2),
      ),
    },
  };
}

function budgetPosture(total, limit) {
  return {
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

export function parseSourceContextWakeRegistryEntries(source) {
  return source
    .split(/\n\s*registryEntry\(\{/)
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

function extractQuotedLocal(source, localName) {
  const match = new RegExp(`${escapeRegExp(localName)}\\s*=\\s+"([^"]+)"`).exec(source);
  if (!match) {
    throw new Error(`Could not find Terraform quoted local '${localName}'.`);
  }
  return match[1];
}

function extractNumericLocal(source, localName) {
  const match = new RegExp(`${localName}\\s+=\\s+([0-9]+)`).exec(source);
  if (!match) {
    throw new Error(`Unable to find numeric local ${localName}.`);
  }
  return Number(match[1]);
}

function extractTernaryNumbers(source, localName) {
  const match = new RegExp(
    `${escapeRegExp(localName)}\\s*=\\s+local\\.is_(?:staging|production) \\? (\\d+) : (\\d+)`,
  ).exec(source);
  if (!match) {
    throw new Error(`Could not find Terraform numeric environment ternary local '${localName}'.`);
  }
  return { trueValue: Number(match[1]), falseValue: Number(match[2]) };
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
