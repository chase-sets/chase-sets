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
    pattern: /(?:^|[^A-Za-z0-9_.-])digitalocean-registry-cleanup\.mjs(?=$|[^A-Za-z0-9_.-])/gm,
  },
  {
    operation: "script:production-db-restore-point-cleanup",
    pattern: /(?:^|[^A-Za-z0-9_.-])production-db-restore-point-cleanup\.mjs(?=$|[^A-Za-z0-9_.-])/gm,
  },
  {
    operation: "script:disable-terraform-prevent-destroy",
    pattern: /(?:^|[^A-Za-z0-9_.-])disable-terraform-prevent-destroy\.mjs(?=$|[^A-Za-z0-9_.-])/gm,
  },
];

const requestedDryRunExpressionPattern = /^\s*\$\{\{\s*github\.event\.inputs\.dry_run\s*\}\}\s*$/;

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

function envEntries(...owners) {
  return Object.entries(
    Object.assign({}, ...owners.map((owner) => (owner?.env && typeof owner.env === "object" ? owner.env : {}))),
  ).filter(([, value]) => typeof value === "string");
}

function referencedEnvVariable(run, variable) {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\$(?:\\{${escaped}\\}|${escaped})(?![A-Za-z0-9_])`).test(run);
}

function hasNonzeroExit(run) {
  return /(?:^|\n)[ \t]*exit[ \t]+[1-9][0-9]*(?:[ \t]*(?:#.*)?)?(?=\r?\n|$)/.test(run);
}

function safeModeResolverTarget(run) {
  if (typeof run !== "string") return null;
  const assignments = [...run.matchAll(/^\s*effective_dry_run="(true|false)"\s*$/gm)].map((match) => match[1]);
  if (JSON.stringify(assignments) !== JSON.stringify(["true", "false", "false"])) return null;

  const resolver =
    /if\s+\[\s*"\$GITHUB_EVENT_NAME"\s*=\s*"schedule"\s*\]\s*;\s*then\s+effective_dry_run="false"\s+elif\s+\[\s*"\$GITHUB_EVENT_NAME"\s*=\s*"workflow_dispatch"\s*\]\s*&&\s*\[\s*"\$DESTRUCTIVE_OPERATION_REQUESTED_DRY_RUN"\s*=\s*"false"\s*\]\s*;\s*then\s+effective_dry_run="false"\s+fi/;
  if (!resolver.test(run)) return null;

  const output = run.match(/echo\s+"([A-Z][A-Z0-9_]*)=\$\{effective_dry_run\}"\s*>>\s*"\$GITHUB_ENV"/);
  return output?.[1] ?? null;
}

function safeResolverVariables(job) {
  const requestedInput = Object.fromEntries(envEntries(job)).DESTRUCTIVE_OPERATION_REQUESTED_DRY_RUN;
  if (!requestedDryRunExpressionPattern.test(requestedInput ?? "")) return [];

  const resolved = [];
  for (const step of job?.steps ?? []) {
    const target = safeModeResolverTarget(step?.run);
    if (target) resolved.push(target);
  }
  return resolved.length === 1 ? resolved : [];
}

function hasScriptDryRunWiring(run, variable) {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `--dry-run=(?:"\\$(?:\\{${escaped}\\}|${escaped})"|'\\$(?:\\{${escaped}\\}|${escaped})'|\\$(?:\\{${escaped}\\}|${escaped})(?=\\s|\\\\|$))`,
  ).test(run);
}

function hasRestorePointApplyWiring(run, variable, environmentEntries) {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const falseBranch = new RegExp(
    `if\\s+\\[\\s*"\\$(?:\\{${escaped}\\}|${escaped})"\\s*=\\s*"false"\\s*\\]\\s*;\\s*then[\\s\\S]*?apply_arg="--apply"[\\s\\S]*?fi`,
  );
  const assignments = [...run.matchAll(/^\s*apply_arg=(.+)$/gm)].map((match) => match[1].trim());
  const applyEnvironment = environmentEntries.find(([name]) => name === "PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY");
  return (
    falseBranch.test(run) &&
    assignments.length === 2 &&
    assignments[0] === '""' &&
    assignments[1] === '"--apply"' &&
    /\$\{apply_arg\}(?=\s|$)/m.test(run) &&
    (run.match(/--apply/g) ?? []).length === 1 &&
    (!applyEnvironment || applyEnvironment[1] === "false") &&
    !/PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY\s*=\s*(?:"?true"?|\$\{\{)/.test(run)
  );
}

function hasProvableModeWiring(workflow, job, step, operations, resolverVariables) {
  const run = step.run;
  const environment = envEntries(workflow, job, ...(job?.steps ?? []));
  const jobRun = (job?.steps ?? [])
    .map((candidate) => (typeof candidate?.run === "string" ? candidate.run : ""))
    .join("\n");
  if (resolverVariables.length === 0) return false;
  return resolverVariables.some((variable) => {
    if (!referencedEnvVariable(run, variable)) return false;
    return operations.every((operation) => {
      if (operation === "script:digitalocean-registry-cleanup") {
        return hasScriptDryRunWiring(run, variable);
      }
      if (operation === "script:production-db-restore-point-cleanup") {
        return (
          hasRestorePointApplyWiring(run, variable, environment) &&
          !/PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY\s*=\s*(?:"?true"?|\$\{\{)/.test(jobRun)
        );
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

function inputHasNoDefault(input) {
  return input && typeof input === "object" && (!Object.hasOwn(input, "default") || input.default === "");
}

function confirmationGate(workflow) {
  const input = workflowDispatchInputs(workflow).confirm;
  const job = workflow?.jobs?.["refuse-unconfirmed-apply"];
  const condition = typeof job?.if === "string" ? job.if : "";
  const gateEnvironment = Object.fromEntries(envEntries(job));
  const environmentIsWired =
    requestedDryRunExpressionPattern.test(gateEnvironment.DESTRUCTIVE_OPERATION_REQUESTED_DRY_RUN ?? "") &&
    /^\s*\$\{\{\s*github\.event\.inputs\.confirm\s*\}\}\s*$/.test(
      gateEnvironment.DESTRUCTIVE_OPERATION_CONFIRMATION ?? "",
    );
  const manualCondition = /^\s*github\.event_name\s*==\s*'workflow_dispatch'\s*$/.test(condition);
  let shellIsAuthoritative = false;
  let phrase = null;

  for (const step of job?.steps ?? []) {
    if (typeof step?.run !== "string" || step["continue-on-error"] === true) continue;
    const run = step.run;
    const trueBranch = run.match(/"true"\s*\)([\s\S]*?)\n\s*;;/);
    const falseBranch = run.match(/"false"\s*\)([\s\S]*?)\n\s*;;/);
    const unknownBranch = run.match(/\*\s*\)([\s\S]*?)\n\s*;;/);
    const confirmation = falseBranch?.[1]?.match(
      /if\s+\[\s*"\$DESTRUCTIVE_OPERATION_CONFIRMATION"\s*!=\s*"([^"]+)"\s*\]\s*;\s*then([\s\S]*?)\n[ \t]*fi(?=\r?\n|$)/,
    );
    if (
      /case\s+"\$DESTRUCTIVE_OPERATION_REQUESTED_DRY_RUN"\s+in/.test(run) &&
      trueBranch &&
      falseBranch &&
      unknownBranch &&
      confirmation &&
      hasNonzeroExit(confirmation[2]) &&
      hasNonzeroExit(unknownBranch[1])
    ) {
      phrase = confirmation[1];
      shellIsAuthoritative = phrase.length > 0;
      break;
    }
  }

  return {
    inputIsTyped: input && typeof input === "object" && input.type === "string",
    inputHasNoDefault: inputHasNoDefault(input),
    jobExists: Boolean(job),
    conditionIsScoped: manualCondition && environmentIsWired && shellIsAuthoritative,
    refuses: shellIsAuthoritative,
    phrase,
  };
}

function destructiveJobNeedsConfirmation(job) {
  const condition = typeof job?.if === "string" ? job.if.replace(/\s+/g, " ").trim() : "";
  return (
    normalizeNeeds(job?.needs).includes("refuse-unconfirmed-apply") &&
    /^!cancelled\(\) && \(needs\.refuse-unconfirmed-apply\.result == 'skipped' \|\| needs\.refuse-unconfirmed-apply\.result == 'success'\)$/.test(
      condition,
    )
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
    if (!gate.inputHasNoDefault) {
      violations.push(`${workflowFile}: workflow_dispatch confirmation input must not default the destructive phrase.`);
    }
    if (!gate.jobExists) {
      violations.push(
        `${workflowFile}: destructive workflow is missing the refuse-unconfirmed-apply confirmation job.`,
      );
    } else {
      if (!gate.conditionIsScoped) {
        violations.push(
          `${workflowFile}: refuse-unconfirmed-apply must shell-validate every manual dry_run value and compare confirmation case-sensitively to a non-empty phrase.`,
        );
      }
      if (!gate.refuses) {
        violations.push(
          `${workflowFile}: refuse-unconfirmed-apply must terminate invalid, empty, unknown, or unconfirmed manual modes with a nonzero exit.`,
        );
      }
    }
  }

  for (const detected of gatedSteps) {
    const resolverVariables = safeResolverVariables(detected.job);
    if (resolverVariables.length === 0) {
      violations.push(
        `${workflowFile}: job '${detected.jobId}' destructive step #${detected.stepIndex} has no fail-closed shell resolver; only exact manual dry_run=false may resolve to apply.`,
      );
    } else if (!hasProvableModeWiring(workflow, detected.job, detected.step, detected.operations, resolverVariables)) {
      violations.push(
        `${workflowFile}: job '${detected.jobId}' destructive step #${detected.stepIndex} cannot associate its invocation with the provable dry-run/apply resolver; failing closed.`,
      );
    }
    if (!destructiveJobNeedsConfirmation(detected.job)) {
      violations.push(
        `${workflowFile}: destructive job '${detected.jobId}' must be cancellation-safe, need refuse-unconfirmed-apply, and run only when that gate is skipped or succeeds.`,
      );
    }
  }

  return { passed: violations.length === 0, checkedSteps, violations };
}

function checkPlatformStagingResetTripwire(source, violations) {
  let workflow;
  try {
    workflow = parse(source);
  } catch (error) {
    violations.push(
      `.github/workflows/platform-staging-reset.yml: named reset tripwire could not parse workflow (${error.message}).`,
    );
    return;
  }
  const input = workflowDispatchInputs(workflow).confirm;
  const resetJob = workflow?.jobs?.["reset-staging"];
  const confirmationStep = (resetJob?.steps ?? []).find(
    (step) =>
      Object.fromEntries(envEntries(step)).RESET_CONFIRM === "${{ inputs.confirm }}" && typeof step?.run === "string",
  );
  const refusalPhrases = ["reset staging", "resume staging recreate"];
  const hasRefusals = refusalPhrases.every((phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = confirmationStep?.run?.match(
      new RegExp(
        `if\\s+\\[\\s*"\\$RESET_CONFIRM"\\s*!=\\s*"${escaped}"\\s*\\]\\s*;\\s*then([\\s\\S]*?)\\n[ \\t]*fi(?=\\r?\\n|$)`,
      ),
    );
    return match && hasNonzeroExit(match[1]);
  });
  if (!input || input.type !== "string" || !inputHasNoDefault(input) || !confirmationStep || !hasRefusals) {
    violations.push(
      ".github/workflows/platform-staging-reset.yml: named reset tripwire requires an unset-by-default typed confirmation and actual nonzero refusal for both exact phrases.",
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
  const destructiveCondition =
    typeof destructiveJob?.if === "string" ? destructiveJob.if.replace(/\s+/g, " ").trim() : "";
  const gateRefuses = (gate?.steps ?? []).some(
    (step) => typeof step?.run === "string" && step["continue-on-error"] !== true && hasNonzeroExit(step.run),
  );
  if (
    !input ||
    input.type !== "string" ||
    !inputHasNoDefault(input) ||
    !/inputs\.action\s*==\s*'apply'/.test(condition) ||
    !/inputs\.confirm\s*!=\s*'reset staging catalog integration data'/.test(condition) ||
    !gateRefuses ||
    !normalizeNeeds(destructiveJob?.needs).includes("refuse-unconfirmed-apply") ||
    !/^!cancelled\(\) && needs\.refuse-production\.result == 'skipped' && needs\.refuse-unconfirmed-apply\.result == 'skipped'$/.test(
      destructiveCondition,
    )
  ) {
    violations.push(
      ".github/workflows/catalog-integration-staging-reset.yml: named reset tripwire requires actual nonzero refusal plus a cancellation-safe destructive-job dependency/result condition.",
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
