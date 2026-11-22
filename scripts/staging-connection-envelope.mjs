#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AUTH_PENDING_REGISTRATION_LOCK_ALLOWANCE,
  buildPushWakeCapacityEvidence,
  loadPushWakeCapacityInputs,
} from "./push-wake-capacity-evidence.mjs";
import { buildPlatformHelmStagingValues, buildPlatformHelmValues } from "./render-platform-helm-values.mjs";
import { buildScenarioSeedJobManifest } from "./platform-kubernetes-deployment.mjs";

const stagingGroup = "platform-deploy-staging";
const CONNECTION_LEDGER_PATH = "docs/architecture/push-wake-connection-budget.md";

/** The ledger row that records the named staging allowance; the envelope trusts no other source. */
export function pendingRegistrationLockAllowanceLedgerRow(allowance = AUTH_PENDING_REGISTRATION_LOCK_ALLOWANCE) {
  return `| ${allowance.name} | ${allowance.environment} only | non-lock rolling ≤ ${allowance.maxNonLockRolling}, locks ≤ ${allowance.maxLockBackends}, rolling total ≤ ${allowance.maxRollingTotal}, every phase ≤ the tier limit |`;
}

export function loadStagingConnectionEnvelopeInputs(repoRoot = process.cwd()) {
  const readWorkflow = (name) => parseYaml(readFileSync(resolve(repoRoot, `.github/workflows/${name}.yml`), "utf8"));
  const values = buildPlatformHelmValues({ repoRoot });
  const stagingWorkerAutoscaling = buildPlatformHelmStagingValues().components["platform-worker"].autoscaling;
  const productionWorkerReplicas = values.components["platform-worker"].replicas;
  const bootstrap = values.components["platform-bootstrap"];
  const bootstrapSource = readFileSync(resolve(repoRoot, "deployables/platform-api/src/bootstrap.ts"), "utf8");
  const seedPoolsSource = readFileSync(resolve(repoRoot, "deployables/platform-api/src/database-pools.ts"), "utf8");
  const workerPoolsSource = readFileSync(
    resolve(repoRoot, "deployables/platform-worker/src/database-pools.ts"),
    "utf8",
  );
  const workerStartupSource = readFileSync(resolve(repoRoot, "deployables/platform-worker/src/main.ts"), "utf8");
  const manifest = buildScenarioSeedJobManifest({
    repoRoot,
    values,
    image: `registry.digitalocean.com/chase-sets/chase-sets-platform@sha256:${"a".repeat(64)}`,
    managedPostgresCaSha256: "a".repeat(64),
    envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
  });
  const advisory = readWorkflow("platform-staging-advisory-evidence");
  const deploy = readWorkflow("platform-production");
  const representative = readWorkflow("platform-staging-representative-commerce-state");
  const fixtures = readWorkflow("platform-staging-admin-qa-actor-fixtures");
  const seedStep = advisory.jobs["staging-advisory-evidence"].steps.find(
    (step) => step.name === "Seed staging Kubernetes scenario data",
  );
  const advisorySteps = advisory.jobs["staging-advisory-evidence"].steps;
  const awaitStep = advisorySteps.find((step) => step.name === "Await staging scenario-seed Job termination");
  const awaitRun = String(awaitStep?.run ?? "");
  const advisoryResumesWorkerBeforeRbacRemoval =
    awaitRun.includes("scenario-seed-release") &&
    awaitRun.indexOf("scenario-seed-release") < awaitRun.indexOf("kubectl delete rolebinding,role,serviceaccount");
  const seedEnv = manifest.spec.template.spec.containers[0].env;
  const groupFor = (workflow, job) => workflow.jobs[job]?.concurrency?.group ?? workflow.concurrency?.group;
  const doesNotCancel = (workflow, job) =>
    (workflow.jobs[job]?.concurrency ?? workflow.concurrency)?.["cancel-in-progress"] === false;
  const capacityInputs = loadPushWakeCapacityInputs(repoRoot);
  const capacity = buildPushWakeCapacityEvidence(capacityInputs);
  const tableCells = (row) =>
    row
      .trim()
      .split("|")
      .map((cell) => cell.trim())
      .join("|");
  const ledgerRows = readFileSync(resolve(repoRoot, CONNECTION_LEDGER_PATH), "utf8").split(/\r?\n/).map(tableCells);
  return {
    lockPoolMax: capacityInputs.defaults.authPendingRegistrationLockPoolMax,
    stagingApiReplicas: capacityInputs.defaults.stagingApiInstances,
    productionApiReplicas: capacityInputs.defaults.productionApiInstances,
    allowance: {
      ...AUTH_PENDING_REGISTRATION_LOCK_ALLOWANCE,
      verified: ledgerRows.includes(tableCells(pendingRegistrationLockAllowanceLedgerRow())),
    },
    productionListenerExpansionDemand: capacity.expansionDecision.wave2DirectListenerExpansion.additionalOverlapDemand,
    pooled: capacity.environments.doksStaging.pgbouncerServerBackendAllocation,
    relays: capacity.environments.doksStaging.directListenerCount,
    waiters: capacity.environments.doksStaging.apiWaiterListenerDemand,
    limit: capacity.environments.doksStaging.limit,
    trigger: capacity.environments.doksStaging.upgradeTrigger,
    productionPooled: capacity.environments.production.pgbouncerServerBackendAllocation,
    productionRelays: capacity.environments.production.directListenerCount,
    productionWaiters: capacity.environments.production.apiWaiterListenerDemand,
    productionLimit: capacity.environments.production.limit,
    productionTrigger: capacity.environments.production.upgradeTrigger,
    directUrls: new Set(
      bootstrap.env
        .filter(
          (entry) =>
            entry.secretKey?.startsWith("BOOTSTRAP_DATABASE_URL_") ||
            entry.secretKey === "BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL",
        )
        .map((entry) => entry.secretKey),
    ).size,
    contextCount: capacity.terraformDefaults.platformContextCount,
    bootstrapPoolMax: Number(bootstrap.env.find((entry) => entry.name === "DATABASE_POOL_MAX")?.value),
    scenarioPoolMax: Number(seedEnv.find((entry) => entry.name === "DATABASE_POOL_MAX")?.value),
    seedPoolsCapped: /function createSeedCommandPools\([^)]*\)\s*\{[\s\S]*?const poolOptions = \{[^}]*max: 1 \}/.test(
      seedPoolsSource,
    ),
    workerSettlementBootstrapPoolMax: Number(
      workerPoolsSource.match(/export function createSettlementBootstrapPool\([^)]*\)\s*\{[\s\S]*?max:\s*(\d+)/)?.[1],
    ),
    workerMaxConcurrentStarts: stagingWorkerAutoscaling.enabled ? stagingWorkerAutoscaling.maxReplicaCount : NaN,
    productionWorkerMaxConcurrentStarts:
      Number.isInteger(productionWorkerReplicas) && productionWorkerReplicas > 0 ? productionWorkerReplicas + 1 : NaN,
    workerSettlementBootstrapBound:
      values.components["platform-worker"].env.some(
        (entry) =>
          entry.name === "BOOTSTRAP_DATABASE_URL_SETTLEMENT" && entry.secretKey === "BOOTSTRAP_DATABASE_URL_SETTLEMENT",
      ) &&
      workerStartupSource.includes("createSettlementBootstrapPool(config)") &&
      workerStartupSource.includes("bootstrapContextDatabase(settlementModule, settlementBootstrapPool)") &&
      workerStartupSource.includes("closeContextPools({ settlementBootstrapPool })"),
    scenarioRestoresWorkers: seedEnv.some(
      (entry) => entry.name === "CHASE_SETS_QUIESCE_RESTORE_ON_SUCCESS" && entry.value === "true",
    ),
    scenarioQuiescesWorkers: Boolean(seedStep?.run?.includes("--quiesce-workers true")),
    advisoryResumesWorkerBeforeRbacRemoval,
    advisoryAwaitsSeedJobTermination:
      Boolean(awaitStep) &&
      advisorySteps.indexOf(awaitStep) === advisorySteps.indexOf(seedStep) + 1 &&
      String(awaitStep.if ?? "").includes("always()") &&
      String(awaitStep.if ?? "").includes("steps.scenario_seed.outcome != 'skipped'") &&
      awaitRun.includes("app.kubernetes.io/component=scenario-seed") &&
      awaitRun.includes("kubectl get job") &&
      awaitRun.includes("kubectl get pods") &&
      awaitRun.includes('[ -z "$active" ]') &&
      awaitRun.includes("--cascade=foreground --wait=true") &&
      advisoryResumesWorkerBeforeRbacRemoval &&
      awaitRun.includes("chase-sets.com/scenario-seed-job=${job}") &&
      awaitRun.includes("kubectl delete rolebinding,role,serviceaccount"),
    bootstrapQuiescesWorkers:
      bootstrap.job?.quiesce?.enabled === true && bootstrap.job.quiesce.targetComponents?.includes("platform-worker"),
    bootstrapBeforeRollout: bootstrap.job?.hook?.events?.includes("pre-upgrade"),
    bootstrapUsesDedicatedLockPool:
      bootstrapSource.includes("createSeedCommandPools(config)") &&
      bootstrapSource.includes("schemaBootstrapLockPool: pools.schemaBootstrapLockPool"),
    bootstrapUsesFullSpanLock:
      bootstrapSource.includes("withSchemaBootstrapLock(") &&
      bootstrapSource.includes('await runBootstrapPhase("seed-api-host"'),
    serializedGroups: [
      groupFor(advisory, "staging-advisory-evidence"),
      groupFor(deploy, "deploy-staging"),
      groupFor(deploy, "reconcile-managed-postgres-ca-staging"),
      groupFor(representative, "refresh-representative-commerce-state"),
      groupFor(fixtures, "provision-admin-qa-actor-fixtures"),
    ],
    serializedJobsDoNotCancel: [
      doesNotCancel(advisory, "staging-advisory-evidence"),
      doesNotCancel(deploy, "deploy-staging"),
      doesNotCancel(deploy, "reconcile-managed-postgres-ca-staging"),
      doesNotCancel(representative, "refresh-representative-commerce-state"),
      doesNotCancel(fixtures, "provision-admin-qa-actor-fixtures"),
    ].every(Boolean),
    dispatchesWithinDeploy: deploy.jobs["deploy-staging"].steps.some(
      (step) => step.name === "Dispatch advisory staging evidence",
    ),
  };
}

export function enforceStagingConnectionEnvelope(input) {
  if (!input.advisoryAwaitsSeedJobTermination || !input.advisoryResumesWorkerBeforeRbacRemoval) {
    throw new Error(
      "Advisory scenario seed must await its Job termination and owner-fenced release before RBAC removal.",
    );
  }
  if (input.directUrls !== input.contextCount || input.directUrls < 1) {
    throw new Error("Staging bootstrap direct URL inventory does not match the context/control budget.");
  }
  if (
    !input.bootstrapQuiescesWorkers ||
    !input.bootstrapBeforeRollout ||
    !input.bootstrapUsesDedicatedLockPool ||
    !input.bootstrapUsesFullSpanLock ||
    !input.seedPoolsCapped ||
    !input.scenarioQuiescesWorkers ||
    !input.scenarioRestoresWorkers ||
    !input.dispatchesWithinDeploy ||
    !input.serializedJobsDoNotCancel ||
    input.serializedGroups[0] !== "platform-staging-advisory-evidence" ||
    input.serializedGroups.slice(1).some((group) => group !== stagingGroup)
  ) {
    throw new Error(
      "Staging bootstrap, advisory owner-fenced seed yield, and rollout must retain their enforced phases.",
    );
  }
  if (
    !Number.isInteger(input.bootstrapPoolMax) ||
    input.bootstrapPoolMax < 1 ||
    input.scenarioPoolMax !== input.bootstrapPoolMax
  ) {
    throw new Error("Staging bootstrap and advisory Jobs must share a positive per-URL direct pool cap.");
  }
  if (
    !input.workerSettlementBootstrapBound ||
    !Number.isInteger(input.workerSettlementBootstrapPoolMax) ||
    input.workerSettlementBootstrapPoolMax < 1 ||
    !Number.isInteger(input.workerMaxConcurrentStarts) ||
    input.workerMaxConcurrentStarts < 1 ||
    !Number.isInteger(input.productionWorkerMaxConcurrentStarts) ||
    input.productionWorkerMaxConcurrentStarts < 1
  ) {
    throw new Error(
      "Staging worker Settlement bootstrap must retain its direct Secret binding, positive pool cap, and positive concurrent-start bounds.",
    );
  }
  if (
    !Number.isInteger(input.lockPoolMax) ||
    input.lockPoolMax < 1 ||
    !Number.isInteger(input.stagingApiReplicas) ||
    input.stagingApiReplicas < 1 ||
    !Number.isInteger(input.productionApiReplicas) ||
    input.productionApiReplicas < 1
  ) {
    throw new Error(
      "Auth pending-registration lock demand needs the verified factory cap and positive canonical API replicas.",
    );
  }
  const allowance = input.allowance ?? null;
  if (allowance) {
    if (allowance.environment !== "staging") {
      throw new Error(`The ${AUTH_PENDING_REGISTRATION_LOCK_ALLOWANCE.name} allowance is staging-only.`);
    }
    if (!(allowance.maxLockBackends > 0)) {
      throw new Error(
        `The ${AUTH_PENDING_REGISTRATION_LOCK_ALLOWANCE.name} allowance must bound counted lock backends.`,
      );
    }
    if (
      !allowance.verified ||
      Object.entries(AUTH_PENDING_REGISTRATION_LOCK_ALLOWANCE).some(([key, value]) => allowance[key] !== value)
    ) {
      throw new Error(
        `The ${AUTH_PENDING_REGISTRATION_LOCK_ALLOWANCE.name} allowance is unverified; ${CONNECTION_LEDGER_PATH} must record it unchanged.`,
      );
    }
  }
  const bootstrap = input.directUrls * input.bootstrapPoolMax + 1; // Dedicated seed schema-lock pool.
  const baseline = input.pooled + input.relays + input.waiters;
  const seed = 26; // The seed regression pins 25 query URLs and a separate direct lock pool at max 1.
  // Each API process holds up to the lock pool cap; a rolling deploy runs two API generations.
  const locks = {
    poolMax: input.lockPoolMax,
    apiReplicas: input.stagingApiReplicas,
    steady: input.lockPoolMax * input.stagingApiReplicas,
    rolling: 2 * input.lockPoolMax * input.stagingApiReplicas,
  };
  const productionLocks = {
    poolMax: input.lockPoolMax,
    apiReplicas: input.productionApiReplicas,
    steady: input.lockPoolMax * input.productionApiReplicas,
    rolling: 2 * input.lockPoolMax * input.productionApiReplicas,
  };
  const nonLockPhases = {
    steady: baseline,
    rolling:
      input.pooled +
      2 * input.relays +
      2 * input.waiters +
      input.workerMaxConcurrentStarts * input.workerSettlementBootstrapPoolMax,
    representative: baseline + seed + input.workerMaxConcurrentStarts * input.workerSettlementBootstrapPoolMax,
    advisory: input.pooled + input.waiters + bootstrap,
    bootstrap: input.pooled + input.waiters + bootstrap,
  };
  // Only a rollout runs two API generations; every other phase runs the steady API replicas.
  const phases = Object.fromEntries(
    Object.entries(nonLockPhases).map(([phase, total]) => [
      phase,
      total + (phase === "rolling" ? locks.rolling : locks.steady),
    ]),
  );
  const nonLockProductionPhases = {
    steady: input.productionPooled + input.productionRelays + input.productionWaiters,
    rolling:
      input.productionPooled +
      2 * input.productionRelays +
      2 * input.productionWaiters +
      input.productionWorkerMaxConcurrentStarts * input.workerSettlementBootstrapPoolMax,
    bootstrap: input.productionPooled + input.productionWaiters + bootstrap,
  };
  const productionPhases = Object.fromEntries(
    Object.entries(nonLockProductionPhases).map(([phase, total]) => [
      phase,
      total + (phase === "rolling" ? productionLocks.rolling : productionLocks.steady),
    ]),
  );
  // Above the trigger, staging rolling demand is admissible only through the
  // named allowance, and only by its lock backends.
  const rollingAdmitted =
    phases.rolling <= input.trigger ||
    (allowance !== null &&
      nonLockPhases.rolling <= allowance.maxNonLockRolling &&
      locks.rolling <= allowance.maxLockBackends &&
      phases.rolling <= allowance.maxRollingTotal);
  if (
    nonLockPhases.rolling > input.trigger ||
    !rollingAdmitted ||
    Object.values(phases).some((total) => total > input.limit)
  ) {
    throw new Error(
      `Staging direct backend envelope exceeds its tier trigger or hard budget: ${JSON.stringify({ nonLock: nonLockPhases, locks: { steady: locks.steady, rolling: locks.rolling }, total: phases })} / trigger ${input.trigger}, ${allowance ? `allowance ${allowance.name} (locks ${allowance.maxLockBackends}, rolling ${allowance.maxRollingTotal})` : "no allowance"}, limit ${input.limit}.`,
    );
  }
  if (
    productionPhases.rolling > input.productionTrigger ||
    Object.values(productionPhases).some((total) => total > input.productionLimit)
  ) {
    throw new Error(
      `Production direct backend envelope exceeds its tier trigger or hard budget: ${JSON.stringify({ nonLock: nonLockProductionPhases, total: productionPhases })} / trigger ${input.productionTrigger}, no allowance, limit ${input.productionLimit}.`,
    );
  }
  const headroom = (totals, limit) =>
    Object.fromEntries(Object.entries(totals).map(([phase, total]) => [phase, limit - total]));
  const productionListenerExpansionRolling = productionPhases.rolling + input.productionListenerExpansionDemand;
  return {
    pooled: input.pooled,
    relays: input.relays,
    waiters: input.waiters,
    directUrls: input.directUrls,
    bootstrap,
    seed,
    workerSettlementBootstrapPoolMax: input.workerSettlementBootstrapPoolMax,
    workerMaxConcurrentStarts: input.workerMaxConcurrentStarts,
    productionWorkerMaxConcurrentStarts: input.productionWorkerMaxConcurrentStarts,
    trigger: input.trigger,
    limit: input.limit,
    allowance: phases.rolling > input.trigger ? allowance.name : null,
    locks,
    nonLockPhases,
    phases,
    headroom: headroom(phases, input.limit),
    rollingTriggerHeadroom: input.trigger - nonLockPhases.rolling,
    productionLocks,
    nonLockProductionPhases,
    productionPhases,
    productionHeadroom: headroom(productionPhases, input.productionLimit),
    productionTrigger: input.productionTrigger,
    productionRollingTriggerHeadroom: input.productionTrigger - productionPhases.rolling,
    productionListenerExpansion: {
      additionalRollingDemand: input.productionListenerExpansionDemand,
      rolling: productionListenerExpansionRolling,
      fitsTrigger: productionListenerExpansionRolling <= input.productionTrigger,
      fitsLimit: productionListenerExpansionRolling <= input.productionLimit,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(JSON.stringify(enforceStagingConnectionEnvelope(loadStagingConnectionEnvelopeInputs())));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
