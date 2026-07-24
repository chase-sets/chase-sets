import { parse } from "yaml";

const operationPatterns = [
  {
    operation: "doctl:registry-repository-delete-tag",
    pattern: /(?:^|[\s;&|$(])doctl\s+registry\s+repository\s+delete-tag(?=\s|$)/gm,
  },
  {
    operation: "doctl:registry-garbage-collection-start",
    pattern: /(?:^|[\s;&|$(])doctl\s+registry\s+garbage-collection\s+start(?=\s|$)/gm,
  },
  {
    operation: "terraform:destroy",
    pattern: /(?:^|[\s;&|$(])terraform\s+(?:-[^\s]+\s+)*destroy(?=\s|$)/gm,
  },
  {
    operation: "script:digitalocean-registry-cleanup",
    pattern: /(?:^|[\s;&|$(])node\s+(?:["']?)[^\s"';&|)]*digitalocean-registry-cleanup\.mjs(?=["'\s;&|)]|$)/gm,
  },
  {
    operation: "script:production-db-restore-point-cleanup",
    pattern: /(?:^|[\s;&|$(])node\s+(?:["']?)[^\s"';&|)]*production-db-restore-point-cleanup\.mjs(?=["'\s;&|)]|$)/gm,
  },
  {
    operation: "script:disable-terraform-prevent-destroy",
    pattern: /(?:^|[\s;&|$(])node\s+(?:["']?)[^\s"';&|)]*disable-terraform-prevent-destroy\.mjs(?=["'\s;&|)]|$)/gm,
  },
];

const safeDryRunResolverPattern =
  /^\s*\$\{\{\s*github\.event_name\s*==\s*'schedule'\s*&&\s*'false'\s*\|\|\s*\(\s*inputs\.dry_run\s*==\s*'true'\s*&&\s*'true'\s*\|\|\s*'false'\s*\)\s*\}\}\s*$/;

// These pre-existing operation classes intentionally sit outside the manual
// cleanup dry-run policy: preview lifecycle teardown, deploy-time production
// housekeeping, and the separately typed-confirmed staging reset. Detection
// happens first; only these exact job/operation multisets are exempt afterward.
const boundedExemptionInventory = Object.freeze({
  ".github/workflows/platform-preview-cleanup.yml": Object.freeze({
    "destroy-preview": Object.freeze([
      Object.freeze(["script:disable-terraform-prevent-destroy"]),
      Object.freeze(["terraform:destroy"]),
    ]),
  }),
  ".github/workflows/platform-production.yml": Object.freeze({
    "deploy-production": Object.freeze([Object.freeze(["script:production-db-restore-point-cleanup"])]),
  }),
  ".github/workflows/platform-staging-reset.yml": Object.freeze({
    "reset-staging": Object.freeze([
      Object.freeze(["script:disable-terraform-prevent-destroy", "terraform:destroy"]),
      Object.freeze(["script:disable-terraform-prevent-destroy", "terraform:destroy"]),
    ]),
  }),
});

export const DESTRUCTIVE_OPERATION_EXEMPTIONS = Object.freeze(
  Object.entries(boundedExemptionInventory).map(([workflowFile, jobs]) =>
    Object.freeze({
      workflowFile,
      jobs: Object.freeze(
        Object.entries(jobs).map(([jobId, expectedStepOperations]) => Object.freeze({ jobId, expectedStepOperations })),
      ),
    }),
  ),
);

export const NAMED_RESET_WORKFLOW_TRIPWIRES = Object.freeze([
  ".github/workflows/platform-staging-reset.yml",
  ".github/workflows/catalog-integration-staging-reset.yml",
]);

function operationSignature(operations) {
  return [...operations].sort().join("+");
}

function sortedStepSignatures(steps) {
  return steps.map((step) => operationSignature(step.operations)).sort();
}

function normalizeNeeds(needs) {
  if (typeof needs === "string") return [needs];
  return Array.isArray(needs) ? needs.filter((value) => typeof value === "string") : [];
}

function workflowTriggers(workflow) {
  const trigger = workflow?.on;
  if (typeof trigger === "string") return [trigger];
  if (Array.isArray(trigger)) return trigger.filter((value) => typeof value === "string");
  return trigger && typeof trigger === "object" ? Object.keys(trigger) : [];
}

function workflowDispatchInputs(workflow) {
  const dispatch = workflow?.on?.workflow_dispatch;
  return dispatch && typeof dispatch === "object" && dispatch.inputs && typeof dispatch.inputs === "object"
    ? dispatch.inputs
    : {};
}

function envEntries(job, step) {
  const jobEnv = job?.env && typeof job.env === "object" ? job.env : {};
  const stepEnv = step?.env && typeof step.env === "object" ? step.env : {};
  return Object.entries({ ...jobEnv, ...stepEnv }).filter(([, value]) => typeof value === "string");
}

function referencedEnvVariable(run, variable) {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\$(?:\\{${escaped}\\}|${escaped})(?![A-Za-z0-9_])`).test(run);
}

function safeResolverVariables(job, step) {
  return envEntries(job, step)
    .filter(([, value]) => safeDryRunResolverPattern.test(value))
    .map(([name]) => name);
}

function hasScriptDryRunWiring(run, variable) {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `--dry-run=(?:"\\$(?:\\{${escaped}\\}|${escaped})"|'\\$(?:\\{${escaped}\\}|${escaped})'|\\$(?:\\{${escaped}\\}|${escaped})(?=\\s|\\\\|$))`,
  ).test(run);
}

function hasRestorePointApplyWiring(run, variable) {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const falseBranch = new RegExp(
    `if\\s+\\[\\s*"\\$(?:\\{${escaped}\\}|${escaped})"\\s*=\\s*"false"\\s*\\]\\s*;\\s*then[\\s\\S]*?apply_arg="--apply"[\\s\\S]*?fi`,
  );
  const assignments = [...run.matchAll(/^\s*apply_arg=(.+)$/gm)].map((match) => match[1].trim());
  return (
    falseBranch.test(run) &&
    assignments.length === 2 &&
    assignments[0] === '""' &&
    assignments[1] === '"--apply"' &&
    /\$\{apply_arg\}(?=\s|$)/m.test(run)
  );
}

function hasProvableModeWiring(run, operations, resolverVariables) {
  if (resolverVariables.length === 0) return false;
  return resolverVariables.some((variable) => {
    if (!referencedEnvVariable(run, variable)) return false;
    return operations.every((operation) => {
      if (operation === "script:digitalocean-registry-cleanup") {
        return hasScriptDryRunWiring(run, variable);
      }
      if (operation === "script:production-db-restore-point-cleanup") {
        return hasRestorePointApplyWiring(run, variable);
      }
      return false;
    });
  });
}

function inputHasTrueDefault(input) {
  return (
    input &&
    typeof input === "object" &&
    input.type === "choice" &&
    input.default === "true" &&
    Array.isArray(input.options) &&
    input.options.length === 2 &&
    [...input.options].sort().join(",") === "false,true"
  );
}

function confirmationGate(workflow) {
  const input = workflowDispatchInputs(workflow).confirm;
  const job = workflow?.jobs?.["refuse-unconfirmed-apply"];
  const condition = typeof job?.if === "string" ? job.if : "";
  const conditionMatch = condition.match(
    /^\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.dry_run\s*==\s*'false'\s*&&\s*inputs\.confirm\s*!=\s*'([^']+)'\s*$/,
  );
  const phrase = conditionMatch?.[1] ?? null;
  const refuses = (job?.steps ?? []).some(
    (step) =>
      typeof step?.run === "string" && step["continue-on-error"] !== true && /(?:^|\n)\s*exit\s+1\s*$/.test(step.run),
  );
  const conditionIsScoped = phrase !== null;

  return {
    inputIsTyped: input && typeof input === "object" && input.type === "string",
    jobExists: Boolean(job),
    conditionIsScoped,
    refuses,
  };
}

function destructiveJobNeedsConfirmation(job) {
  const condition = typeof job?.if === "string" ? job.if : "";
  return (
    normalizeNeeds(job?.needs).includes("refuse-unconfirmed-apply") &&
    /^\s*always\(\)\s*&&\s*needs\.refuse-unconfirmed-apply\.result\s*==\s*'skipped'\s*$/.test(condition)
  );
}

export function detectDestructiveOperations(run) {
  if (typeof run !== "string") return [];
  const matches = [];
  for (const { operation, pattern } of operationPatterns) {
    pattern.lastIndex = 0;
    for (const match of run.matchAll(pattern)) {
      matches.push({ operation, index: match.index ?? 0 });
    }
  }
  return matches
    .sort((left, right) => left.index - right.index || left.operation.localeCompare(right.operation))
    .map(({ operation }) => operation);
}

function detectWorkflowSteps(workflow) {
  const detected = [];
  for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
    if (!job || typeof job !== "object" || !Array.isArray(job.steps)) continue;
    job.steps.forEach((step, stepIndex) => {
      if (!step || typeof step !== "object" || typeof step.run !== "string") return;
      const operations = detectDestructiveOperations(step.run);
      if (operations.length === 0) return;
      detected.push({
        jobId,
        job,
        step,
        stepIndex: stepIndex + 1,
        name: typeof step.name === "string" ? step.name : "unnamed step",
        run: step.run,
        operations,
      });
    });
  }
  return detected;
}

function exemptionDisposition(workflowFile, detectedSteps, violations) {
  const declaredJobs = boundedExemptionInventory[workflowFile];
  const exempt = new Set();
  if (!declaredJobs) return exempt;

  for (const [jobId, expectedOperations] of Object.entries(declaredJobs)) {
    const actualSteps = detectedSteps.filter((step) => step.jobId === jobId);
    const actual = sortedStepSignatures(actualSteps);
    const expected = expectedOperations.map(operationSignature).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      violations.push(
        `${workflowFile}: bounded destructive-operation exemption for job '${jobId}' changed; expected step operations [${expected.join(
          ", ",
        )}], observed [${actual.join(", ")}]. Exemptions are exact and may not grow.`,
      );
      continue;
    }
    for (const step of actualSteps) exempt.add(step);
  }
  return exempt;
}

export function checkWorkflowDestructiveOperationGating(source, { workflowFile = "workflow" } = {}) {
  const checkedSteps = [];
  const violations = [];
  let workflow;
  try {
    workflow = parse(source);
  } catch (error) {
    if (detectDestructiveOperations(source).length > 0) {
      violations.push(
        `${workflowFile}: destructive invocation was found but the workflow could not be parsed, so no gate can be proven; failing closed (${error.message}).`,
      );
    }
    return { passed: violations.length === 0, checkedSteps, violations };
  }

  const detectedSteps = detectWorkflowSteps(workflow);
  const exempt = exemptionDisposition(workflowFile, detectedSteps, violations);
  const gatedSteps = detectedSteps.filter((step) => !exempt.has(step));
  const triggers = workflowTriggers(workflow).sort();
  const dispatchInputs = workflowDispatchInputs(workflow);
  const gate = confirmationGate(workflow);

  for (const detected of detectedSteps) {
    checkedSteps.push({
      jobId: detected.jobId,
      stepIndex: detected.stepIndex,
      name: detected.name,
      operations: detected.operations,
      disposition: exempt.has(detected) ? "bounded-exemption" : "provable-gate",
    });
  }

  if (gatedSteps.length > 0) {
    if (triggers.length !== 2 || triggers[0] !== "schedule" || triggers[1] !== "workflow_dispatch") {
      violations.push(
        `${workflowFile}: gated destructive workflow must be triggered only by schedule and workflow_dispatch so apply can be forced only for schedule events; observed [${triggers.join(
          ", ",
        )}].`,
      );
    }
    if (!inputHasTrueDefault(dispatchInputs.dry_run)) {
      violations.push(
        `${workflowFile}: workflow_dispatch dry_run must be a true/false choice that defaults to "true".`,
      );
    }
    if (!gate.inputIsTyped) {
      violations.push(
        `${workflowFile}: workflow_dispatch must declare a typed string confirmation input named 'confirm'.`,
      );
    }
    if (!gate.jobExists) {
      violations.push(
        `${workflowFile}: destructive workflow is missing the refuse-unconfirmed-apply confirmation job.`,
      );
    } else {
      if (!gate.conditionIsScoped) {
        violations.push(
          `${workflowFile}: refuse-unconfirmed-apply must reject manual dry_run=false unless inputs.confirm equals a non-empty typed phrase.`,
        );
      }
      if (!gate.refuses) {
        violations.push(
          `${workflowFile}: refuse-unconfirmed-apply must terminate the unconfirmed apply path with exit 1.`,
        );
      }
    }
  }

  for (const detected of gatedSteps) {
    const resolverVariables = safeResolverVariables(detected.job, detected.step);
    if (resolverVariables.length === 0) {
      violations.push(
        `${workflowFile}: job '${detected.jobId}' destructive step #${detected.stepIndex} has no provable resolver; manual dry_run=true can resolve to apply.`,
      );
    } else if (!hasProvableModeWiring(detected.run, detected.operations, resolverVariables)) {
      violations.push(
        `${workflowFile}: job '${detected.jobId}' destructive step #${detected.stepIndex} cannot associate its invocation with the provable dry-run/apply resolver; failing closed.`,
      );
    }
    if (!destructiveJobNeedsConfirmation(detected.job)) {
      violations.push(
        `${workflowFile}: destructive job '${detected.jobId}' must need refuse-unconfirmed-apply and run only when that confirmation job is skipped.`,
      );
    }
  }

  return { passed: violations.length === 0, checkedSteps, violations };
}

function checkPlatformStagingResetTripwire(source, violations) {
  const requiredPatterns = [
    /RESET_CONFIRM:\s*\$\{\{\s*inputs\.confirm\s*\}\}/,
    /"\$RESET_CONFIRM"\s*!=\s*"reset staging"/,
    /"\$RESET_CONFIRM"\s*!=\s*"resume staging recreate"/,
  ];
  if (requiredPatterns.some((pattern) => !pattern.test(source))) {
    violations.push(
      ".github/workflows/platform-staging-reset.yml: named reset tripwire requires RESET_CONFIRM and both exact typed-confirmation comparisons.",
    );
  }
}

function checkCatalogIntegrationResetTripwire(source, violations) {
  let workflow;
  try {
    workflow = parse(source);
  } catch (error) {
    violations.push(
      `.github/workflows/catalog-integration-staging-reset.yml: named reset tripwire could not parse workflow (${error.message}).`,
    );
    return;
  }
  const input = workflowDispatchInputs(workflow).confirm;
  const gate = workflow?.jobs?.["refuse-unconfirmed-apply"];
  const destructiveJob = workflow?.jobs?.["catalog-integration-reset"];
  const condition = typeof gate?.if === "string" ? gate.if : "";
  if (
    !input ||
    input.type !== "string" ||
    !/inputs\.action\s*==\s*'apply'/.test(condition) ||
    !/inputs\.confirm\s*!=\s*'reset staging catalog integration data'/.test(condition) ||
    !normalizeNeeds(destructiveJob?.needs).includes("refuse-unconfirmed-apply")
  ) {
    violations.push(
      ".github/workflows/catalog-integration-staging-reset.yml: named reset tripwire requires the refuse-unconfirmed-apply typed-confirmation gate and destructive-job dependency.",
    );
  }
}

export function checkNamedResetWorkflowTripwires(workflowSources) {
  const checkedWorkflows = [...NAMED_RESET_WORKFLOW_TRIPWIRES];
  const violations = [];
  const staging = workflowSources?.[NAMED_RESET_WORKFLOW_TRIPWIRES[0]];
  const catalog = workflowSources?.[NAMED_RESET_WORKFLOW_TRIPWIRES[1]];

  if (typeof staging !== "string") {
    violations.push(`${NAMED_RESET_WORKFLOW_TRIPWIRES[0]}: named reset workflow source is missing.`);
  } else {
    checkPlatformStagingResetTripwire(staging, violations);
  }
  if (typeof catalog !== "string") {
    violations.push(`${NAMED_RESET_WORKFLOW_TRIPWIRES[1]}: named reset workflow source is missing.`);
  } else {
    checkCatalogIntegrationResetTripwire(catalog, violations);
  }

  return { passed: violations.length === 0, checkedWorkflows, violations };
}
