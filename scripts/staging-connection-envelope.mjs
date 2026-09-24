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
  const groupFor = (workflow, job) => workflow.jobs[job]?.concurrency?.group;
  const capacity = buildPushWakeCapacityEvidence(loadPushWakeCapacityInputs(repoRoot));
  return {
    pooled: capacity.environments.doksStaging.pgbouncerServerBackendAllocation,
    relays: capacity.environments.doksStaging.directListenerCount,
    waiters: capacity.environments.doksStaging.apiWaiterListenerDemand,
    limit: capacity.environments.doksStaging.limit,
    trigger: capacity.environments.doksStaging.upgradeTrigger,
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
    scenarioPoolMax: Number(
      manifest.spec.template.spec.containers[0].env.find((entry) => entry.name === "DATABASE_POOL_MAX")?.value,
    ),
    scenarioRestoresWorkers: manifest.spec.template.spec.containers[0].env.some(
      (entry) => entry.name === "CHASE_SETS_QUIESCE_RESTORE_ON_SUCCESS" && entry.value === "true",
    ),
    scenarioQuiescesWorkers: Boolean(seedStep?.run?.includes("--quiesce-workers true")),
    bootstrapQuiescesWorkers:
      bootstrap.job?.quiesce?.enabled === true && bootstrap.job.quiesce.targetComponents?.includes("platform-worker"),
    bootstrapBeforeRollout: bootstrap.job?.hook?.events?.includes("pre-upgrade"),
    serializedGroups: [
      groupFor(advisory, "staging-advisory-evidence"),
      groupFor(deploy, "deploy-staging"),
      groupFor(deploy, "reconcile-managed-postgres-ca-staging"),
      groupFor(representative, "refresh-representative-commerce-state"),
      groupFor(fixtures, "provision-admin-qa-actor-fixtures"),
    ],
    dispatchesWithinDeploy: deploy.jobs["deploy-staging"].steps.some(
      (step) => step.name === "Dispatch advisory staging evidence",
    ),
  };
}

export function enforceStagingConnectionEnvelope(input) {
  if (input.directUrls !== input.contextCount || input.directUrls < 1) {
    throw new Error("Staging bootstrap direct URL inventory does not match the context/control budget.");
  }
  if (
    !input.bootstrapQuiescesWorkers ||
    !input.bootstrapBeforeRollout ||
    !input.scenarioQuiescesWorkers ||
    !input.scenarioRestoresWorkers ||
    !input.dispatchesWithinDeploy ||
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
  const bootstrap = input.directUrls * input.bootstrapPoolMax;
  const baseline = input.pooled + input.relays + input.waiters;
  const seed = 25; // The independent seed-command pool regression pins 25 direct URLs at max 1.
  const phases = {
    rolling: input.pooled + 2 * input.relays + 2 * input.waiters,
    representative: baseline + seed,
    advisory: input.pooled + input.waiters + bootstrap,
    bootstrap: input.pooled + input.waiters + bootstrap,
  };
  if (phases.rolling > input.trigger || Object.values(phases).some((total) => total > input.limit)) {
    throw new Error(
      `Staging direct backend envelope exceeds its tier trigger or hard budget: ${JSON.stringify(phases)} / ${input.trigger}, ${input.limit}.`,
    );
  }
  return {
    pooled: input.pooled,
    relays: input.relays,
    waiters: input.waiters,
    directUrls: input.directUrls,
    bootstrap,
    seed,
    trigger: input.trigger,
    limit: input.limit,
    phases,
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
