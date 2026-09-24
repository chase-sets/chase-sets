#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadPushWakeCapacityInputs, buildPushWakeCapacityEvidence } from "./push-wake-capacity-evidence.mjs";
import { buildPlatformHelmValues } from "./render-platform-helm-values.mjs";
import { buildScenarioSeedJobManifest } from "./platform-kubernetes-deployment.mjs";

const stagingGroup = "platform-deploy-staging";

export function loadStagingConnectionEnvelopeInputs(repoRoot = process.cwd()) {
  const readWorkflow = (name) => parseYaml(readFileSync(resolve(repoRoot, `.github/workflows/${name}.yml`), "utf8"));
  const values = buildPlatformHelmValues({ repoRoot });
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
    awaitRun.includes("autoscaling.keda.sh/paused-replicas-") &&
    awaitRun.indexOf("autoscaling.keda.sh/paused-replicas-") <
      awaitRun.indexOf("kubectl delete rolebinding,role,serviceaccount");
  const seedEnv = manifest.spec.template.spec.containers[0].env;
  const groupFor = (workflow, job) => workflow.jobs[job]?.concurrency?.group;
  const doesNotCancel = (workflow, job) => workflow.jobs[job]?.concurrency?.["cancel-in-progress"] === false;
  const capacity = buildPushWakeCapacityEvidence(loadPushWakeCapacityInputs(repoRoot));
  return {
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
    throw new Error("Advisory scenario seed must hold platform-deploy-staging until its Kubernetes Job terminates.");
  }
  if (input.directUrls !== input.contextCount || input.directUrls < 1) {
    throw new Error("Staging bootstrap direct URL inventory does not match the context/control budget.");
  }
  if (
    !input.bootstrapQuiescesWorkers ||
    !input.bootstrapBeforeRollout ||
    !input.bootstrapUsesDedicatedLockPool ||
    !input.seedPoolsCapped ||
    !input.scenarioQuiescesWorkers ||
    !input.scenarioRestoresWorkers ||
    !input.dispatchesWithinDeploy ||
    !input.serializedJobsDoNotCancel ||
    input.serializedGroups.some((group) => group !== stagingGroup)
  ) {
    throw new Error("Staging bootstrap, advisory, seed commands, and rollout must retain their enforced phases.");
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
    input.workerSettlementBootstrapPoolMax < 1
  ) {
    throw new Error("Staging worker Settlement bootstrap must retain its direct Secret binding and positive pool cap.");
  }
  const bootstrap = input.directUrls * input.bootstrapPoolMax + 1; // Dedicated seed schema-lock pool.
  const baseline = input.pooled + input.relays + input.waiters;
  const seed = 26; // The seed regression pins 25 query URLs and a separate direct lock pool at max 1.
  const phases = {
    rolling: input.pooled + 2 * input.relays + 2 * input.waiters + 2 * input.workerSettlementBootstrapPoolMax,
    representative: baseline + seed,
    advisory: input.pooled + input.waiters + bootstrap,
    bootstrap: input.pooled + input.waiters + bootstrap,
  };
  const productionPhases = {
    rolling:
      input.productionPooled +
      2 * input.productionRelays +
      2 * input.productionWaiters +
      2 * input.workerSettlementBootstrapPoolMax,
    bootstrap: input.productionPooled + input.productionWaiters + bootstrap,
  };
  if (phases.rolling > input.trigger || Object.values(phases).some((total) => total > input.limit)) {
    throw new Error(
      `Staging direct backend envelope exceeds its tier trigger or hard budget: ${JSON.stringify(phases)} / ${input.trigger}, ${input.limit}.`,
    );
  }
  if (
    productionPhases.rolling > input.productionTrigger ||
    Object.values(productionPhases).some((total) => total > input.productionLimit)
  ) {
    throw new Error(
      `Production direct backend envelope exceeds its tier trigger or hard budget: ${JSON.stringify(productionPhases)} / ${input.productionTrigger}, ${input.productionLimit}.`,
    );
  }
  return {
    pooled: input.pooled,
    relays: input.relays,
    waiters: input.waiters,
    directUrls: input.directUrls,
    bootstrap,
    seed,
    workerSettlementBootstrapPoolMax: input.workerSettlementBootstrapPoolMax,
    trigger: input.trigger,
    limit: input.limit,
    phases,
    productionPhases,
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
