#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption, readRepeatedOptions } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const PLATFORM_DEPLOY_INCIDENT_VERSION = "platform-deploy-incident/v2";

const NO_OP_INCIDENT_TITLE_PREFIX = "Incident: Platform Deploy superseded before production for ";
const ROOT_CAUSE_SCHEMA_VERSION = "platform-deploy-root-cause/v1";
const MAX_PROVIDER_REASON_LENGTH = 500;

export const DEPLOY_ROOT_CAUSE_CODES = Object.freeze([
  "doks-bootstrap-or-migration",
  "terraform-provider-or-state",
  "staging-dns",
  "staging-advisory-seed-or-e2e",
  "blocking-staging-verification",
  "production-verification",
  "superseded-pre-mutation",
  "agent-grant-revocation-activation-refused",
  "doks-admission-webhook-unreachable",
  "staging-browser-install",
  "unknown",
]);

const ROOT_CAUSES = Object.freeze({
  "doks-bootstrap-or-migration": {
    summary: "The DOKS bootstrap or database migration did not complete.",
    remediation: "Resolve the bootstrap or migration failure; do not retry deterministic failures until corrected.",
    phase: "doks-bootstrap-or-migration",
    affectedComponent: "platform-bootstrap",
  },
  "terraform-provider-or-state": {
    summary: "Terraform provider execution or state handling failed.",
    remediation:
      "Inspect the Terraform diagnostics and protected errored-state artifact before applying a recovery plan.",
    phase: "terraform",
    affectedComponent: "terraform",
  },
  "staging-dns": {
    summary: "Staging DNS reconciliation or domain attachment failed.",
    remediation: "Correct the conflicting or invalid staging DNS record or attachment, then rerun the deploy.",
    phase: "staging-dns",
    affectedComponent: "staging-dns",
  },
  "staging-advisory-seed-or-e2e": {
    summary: "A staging advisory seed or end-to-end check failed.",
    remediation:
      "Inspect the redacted seed or E2E evidence and repair the advisory check without weakening blocking gates.",
    phase: "staging-advisory",
    affectedComponent: "staging-advisory",
  },
  "blocking-staging-verification": {
    summary: "A blocking staging verification did not pass.",
    remediation: "Resolve the failed staging verification and prove it passes before promotion.",
    phase: "staging-verification",
    affectedComponent: "staging-verification",
  },
  "production-verification": {
    summary: "A production verification failed after deployment began.",
    remediation:
      "Inspect the redacted production evidence and rollback result, then fix forward or recover from the proven target.",
    phase: "production-verification",
    affectedComponent: "production-verification",
  },
  "superseded-pre-mutation": {
    summary: "The release was superseded before it mutated the target environment.",
    remediation: "No recovery is required; the newer main commit owns the deploy lane.",
    phase: "pre-mutation",
    affectedComponent: "deploy-lane",
  },
  "agent-grant-revocation-activation-refused": {
    summary:
      "Agent Grant revocation activation refused after the release was healthy; the release was neither aborted nor rolled back.",
    remediation:
      "Read the refusal code and the agent-grant-revocation-status artifact, then follow the activation runbook; do not retry a non-transient refusal until it is resolved.",
    phase: "agent-grant-revocation-activation",
    affectedComponent: "agent-grant-revocation",
  },
  "doks-admission-webhook-unreachable": {
    summary:
      "The production Helm upgrade failed because the DOKS control plane could not reach an admission webhook (No agent available).",
    remediation:
      "The deploy restores the last-known-good release and retries once; when that retry is refused or fails, confirm the admission webhook answers a server dry-run, then rerun the failed Platform Deploy run.",
    phase: "production-deploy",
    affectedComponent: "doks-control-plane",
  },
  "staging-browser-install": {
    summary: "The bounded Playwright Chromium installer failed during staging.",
    remediation:
      "Inspect the bounded installer diagnostic and repair the browser download or runner cache before retrying staging.",
    phase: "staging-browser-install",
    affectedComponent: "staging-browser-install",
  },
  unknown: {
    summary: "The deployment failed without a known safe classification.",
    remediation: "Inspect the redacted provider reason and diagnostic artifacts before retrying or recovering.",
    phase: "unknown",
    affectedComponent: "unknown",
  },
});

export function redactDeployDiagnosticText(value) {
  return String(value ?? "")
    .replace(/(^|\r?\n)(\s*(?:cookie|set-cookie)\s*:\s*)([^\r\n]*)/gim, (_match, lineStart, prefix, headerValue) => {
      const redactedValue = headerValue.replace(/(^|;\s*)([^=;\s]+)(\s*=\s*)[^;]*/g, "$1$2$3[REDACTED]");
      return `${lineStart}${prefix}${redactedValue}`;
    })
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^:\s/"']+:[^@\s/"']+@/gi, "$1[REDACTED]@")
    .replace(
      /((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/)[^\s"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:gho_|ghp_|ghs_|github_pat_|dop_v1_|sk_(?:live|test)_)[A-Za-z0-9_-]+/gi, "[REDACTED_TOKEN]")
    .replace(
      /(\b(?:[A-Z][A-Z0-9_]*_)?(?:PASSWORD|PWD|SECRET|TOKEN|API_KEY|COOKIE|DATABASE_URL|CONNECTION_STRING)(?:_[A-Z0-9_]+)*\s*=\s*)([^\s,;]+)/g,
      "$1[REDACTED]",
    )
    .replace(
      /((?:\\?["'])?(?:password|pwd|secret|token|api[_-]?key|cookie|set-cookie|database[_-]?url|connection[_-]?string)(?:\\?["'])?\s*[=:]\s*(?:\\?["'])?)([^\s,;}'"\\]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/((?:x-api-key|x-auth-token|proxy-authorization)\s*:\s*)\S+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]");
}

function boundedProviderReason(value) {
  const redacted = redactDeployDiagnosticText(value).replace(/\s+/g, " ").trim();
  return redacted.length <= MAX_PROVIDER_REASON_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_PROVIDER_REASON_LENGTH)}...`;
}

function diagnosticText(input) {
  const logs = (input.logs ?? []).map((entry) => entry.output ?? entry.error ?? "");
  const diagnostics = (input.diagnostics ?? []).map((entry) =>
    typeof entry === "string" ? entry : JSON.stringify(entry),
  );
  return redactDeployDiagnosticText([...logs, ...diagnostics, input.message ?? ""].join("\n"));
}

function normalizedSteps(input) {
  function visit(steps, inheritedComponent = "") {
    return (steps ?? []).flatMap((step) => {
      const name = String(step.name ?? step.Name ?? "");
      const genericName = /^(?:deploy|build|prepare|finalize|route|wait)$/i.test(name);
      const explicitComponent = step.componentName ?? step.component_name ?? "";
      const componentName = String(explicitComponent || (!genericName ? name : "") || inheritedComponent || "unknown");
      const normalized = {
        name,
        componentName,
        phase: String(step.phase ?? step.Phase ?? step.status ?? step.Status ?? ""),
        reasonCode: String(step.reasonCode ?? step.reason?.code ?? step.Reason?.Code ?? step.reason ?? ""),
        message: String(step.message ?? step.Message ?? step.reason?.message ?? step.Reason?.Message ?? ""),
      };
      const progress = step.progress ?? step.Progress ?? {};
      const children = [
        ...(step.steps ?? step.Steps ?? []),
        ...(step.children ?? step.Children ?? []),
        ...(step.substeps ?? step.sub_steps ?? step.Substeps ?? []),
        ...(progress.steps ?? progress.Steps ?? []),
      ];
      return [normalized, ...visit(children, componentName)];
    });
  }

  return visit(input.steps ?? []);
}

function providerReasonFromStep(step) {
  return boundedProviderReason([step?.reasonCode, step?.message].filter(Boolean).join(": "));
}

function relevantProviderReason(steps, text, providerStep) {
  const failed =
    providerStep ??
    steps.find((step) => /error|fail|cancel|timeout/i.test(step.phase) && (step.reasonCode || step.message));
  const reason = providerReasonFromStep(failed);
  if (reason) {
    return boundedProviderReason(reason);
  }
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return boundedProviderReason(firstLine || "No provider reason was captured.");
}

function relevantTextLine(text, pattern) {
  return boundedProviderReason(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => pattern.test(line)) ?? "",
  );
}

// An admission call the DOKS control plane could not route through its konnectivity
// bridge, exactly as the API server reports it inside a Helm resource error.
const admissionWebhookNoAgentCall = String.raw`(?:cannot (?:patch|create|update|delete) "[^"]+" with kind [A-Za-z]+: )?Internal error occurred: failed calling webhook "[^"\s]+": failed to call webhook: Post "[^"\s]+": No agent available`;
// Helm's two atomic renditions; only the original upgrade error is matched, never a hook
// failure or a rollback-only error.
const helmAdmissionWebhookTransientPattern = new RegExp(
  String.raw`^UPGRADE FAILED: (?:an error occurred while rolling back the release\. original upgrade error: ${admissionWebhookNoAgentCall}(?:: |$)|release \S+ failed, and has been rolled back due to atomic being set: ${admissionWebhookNoAgentCall}$)`,
);
const ADMISSION_WEBHOOK_TRANSIENT_MAX_LENGTH = 500;

export function classifyAdmissionWebhookTransient(text) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .filter((candidate) => candidate.includes("UPGRADE FAILED: "))
    .at(-1);
  if (!line) {
    return null;
  }
  const failure = line.slice(line.indexOf("UPGRADE FAILED: ")).trim();
  if (!helmAdmissionWebhookTransientPattern.test(failure)) {
    return null;
  }
  return redactDeployDiagnosticText(failure).replace(/\s+/g, " ").slice(0, ADMISSION_WEBHOOK_TRANSIENT_MAX_LENGTH);
}

// The only recognition code a deploy attempt carries. The producer sets it exactly when the
// complete original error matched above; the bounded line can lose `No agent available`, so
// readers trust this code and never match the line again.
export const ADMISSION_WEBHOOK_TRANSIENT_CODE = "doks-admission-webhook-unreachable";

// A recognized failure carries the code with its nonempty bounded line; every other
// attempt carries neither.
export function hasAdmissionWebhookTransientPair(attempt) {
  const { admissionWebhookTransient: line, admissionWebhookTransientCode: code } = attempt;
  if (code === null) {
    return line === null;
  }
  return (
    code === ADMISSION_WEBHOOK_TRANSIENT_CODE &&
    attempt.result === "failure" &&
    typeof line === "string" &&
    line.length > 0 &&
    line.length <= ADMISSION_WEBHOOK_TRANSIENT_MAX_LENGTH
  );
}

const DEPLOY_ATTEMPTS_SCHEMA_VERSION = "platform-kubernetes-deploy-attempts/v1";
const deployAttemptsRecordKeys = [
  "attempts",
  "namespace",
  "preRetryHistory",
  "probeSamples",
  "recovery",
  "refusal",
  "release",
  "result",
  "retry",
  "schemaVersion",
];
const deployAttemptKeys = ["admissionWebhookTransient", "admissionWebhookTransientCode", "attempt", "result"];
const hasExactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);

// The production deploy's closed attempts record names the admission transient only
// when its last attempt failed carrying the recognition code; a malformed record is not
// evidence, and anything else keeps today's taxonomy.
function admissionWebhookTransientFromAttempts(diagnostics) {
  for (const record of diagnostics ?? []) {
    if (
      !hasExactKeys(record, deployAttemptsRecordKeys) ||
      record.schemaVersion !== DEPLOY_ATTEMPTS_SCHEMA_VERSION ||
      !Array.isArray(record.attempts) ||
      record.attempts.length < 1 ||
      record.attempts.length > 2 ||
      !record.attempts.every(
        (attempt, index) =>
          hasExactKeys(attempt, deployAttemptKeys) &&
          attempt.attempt === index + 1 &&
          ["success", "failure"].includes(attempt.result) &&
          hasAdmissionWebhookTransientPair(attempt),
      ) ||
      record.result !== record.attempts.at(-1).result
    ) {
      continue;
    }
    const last = record.attempts.at(-1);
    if (record.result === "failure" && last.admissionWebhookTransientCode === ADMISSION_WEBHOOK_TRANSIENT_CODE) {
      return last.admissionWebhookTransient;
    }
  }
  return null;
}

function providerOverridesForMatch(steps, text, pattern) {
  const providerStep = steps.find((step) =>
    pattern.test([step.name, step.componentName, step.phase, step.reasonCode, step.message].join(" ")),
  );
  if (providerStep) {
    return { providerStep };
  }

  const providerReason = relevantTextLine(text, pattern);
  return providerReason ? { providerReason } : {};
}

function normalizedSignatureReason(providerReason) {
  return String(providerReason ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function rootCauseSignature(rootCauseCode, affectedComponent, phase, providerReason) {
  return createHash("sha256")
    .update([rootCauseCode, affectedComponent, phase, normalizedSignatureReason(providerReason)].join("|"))
    .digest("hex")
    .slice(0, 12);
}

function rootCauseRecord(code, input, steps, text, overrides = {}) {
  const definition = ROOT_CAUSES[code] ?? ROOT_CAUSES.unknown;
  const failedComponent = steps.find((step) => /error|fail|cancel|timeout/i.test(step.phase))?.componentName;
  const affectedComponent =
    overrides.affectedComponent ||
    input.affectedComponent ||
    (code === "unknown" && failedComponent ? failedComponent : definition.affectedComponent);
  const phase = overrides.phase || definition.phase;
  const providerReason = overrides.providerReason || relevantProviderReason(steps, text, overrides.providerStep);
  return {
    schemaVersion: ROOT_CAUSE_SCHEMA_VERSION,
    rootCauseCode: code,
    rootCauseSummary: definition.summary,
    affectedComponent,
    phase,
    remediation: definition.remediation,
    providerReason,
    rootCauseSignature: rootCauseSignature(code, affectedComponent, phase, providerReason),
    blocking: code !== "staging-advisory-seed-or-e2e" && code !== "superseded-pre-mutation",
  };
}

export function classifyDeploymentRootCause(input = {}) {
  const steps = normalizedSteps(input);
  const text = diagnosticText(input);
  const phaseHint = String(input.phase ?? "").toLowerCase();
  const stepText = steps
    .map((step) => [step.name, step.componentName, step.phase, step.reasonCode, step.message].join(" "))
    .join("\n");
  const allText = `${stepText}\n${text}`;
  const stagingDnsPattern =
    /DomainZoneInvalid|DomainCNAMEMismatch|domain (?:name )?.{0,40}(?:already exists|conflict|collision)|CNAME.{0,40}(?:mismatch|conflict)|staging-dns/i;
  const terraformPattern =
    /Error acquiring the state lock|Failed to (?:load|save|persist) state|errored\.tfstate|terraform provider|Provider produced inconsistent|Backend initialization required/i;
  const doksBootstrapPattern =
    /Schema bootstrap|bootstrap (?:command )?(?:timed out|failed)|lock_timeout|lock was not acquired|migration.{0,60}(?:failed|timeout)|seed-api-host.{0,60}exceeded/i;
  const stagingAdvisoryPattern =
    /advisory.{0,40}(?:seed|e2e)|(?:seed|e2e).{0,40}advisory|end-to-end.{0,80}auth(?:entication|orization)|e2e.{0,80}(?:login|auth(?:entication|orization))/i;
  const stagingVerificationPattern =
    /projection.{0,80}(?:convergence|checkpoint|freshness).{0,80}(?:timed out|timeout|failed)|blocking verification/i;
  const stagingBrowserInstallPattern =
    /Playwright Chromium install failed|playwright-chromium-install|staging-playwright-install|staging-browser-install/i;

  if (input.superseded === true || /superseded-pre-mutation/.test(phaseHint)) {
    return rootCauseRecord("superseded-pre-mutation", input, steps, text);
  }
  if (phaseHint === "agent-grant-revocation-activation") {
    // The status record's refusal is already a bounded code; nothing else is carried.
    const refusal = (input.diagnostics ?? [])
      .map((diagnostic) => diagnostic?.refusal)
      .find((code) => typeof code === "string" && /^revocation_[a-z_]{1,64}$/.test(code));
    return rootCauseRecord("agent-grant-revocation-activation-refused", input, steps, text, {
      providerReason: refusal ?? "revocation_release_refused",
    });
  }
  const admissionWebhookTransient = admissionWebhookTransientFromAttempts(input.diagnostics);
  if (admissionWebhookTransient) {
    return rootCauseRecord("doks-admission-webhook-unreachable", input, steps, text, {
      providerReason: admissionWebhookTransient,
    });
  }
  if (stagingDnsPattern.test(allText)) {
    return rootCauseRecord(
      "staging-dns",
      input,
      steps,
      text,
      providerOverridesForMatch(steps, text, stagingDnsPattern),
    );
  }
  if (/terraform-provider-or-state/.test(phaseHint) || terraformPattern.test(allText)) {
    return rootCauseRecord(
      "terraform-provider-or-state",
      input,
      steps,
      text,
      providerOverridesForMatch(steps, text, terraformPattern),
    );
  }
  if (/doks-bootstrap|migration/.test(phaseHint) || doksBootstrapPattern.test(allText)) {
    return rootCauseRecord(
      "doks-bootstrap-or-migration",
      input,
      steps,
      text,
      providerOverridesForMatch(steps, text, doksBootstrapPattern),
    );
  }
  if (/staging-advisory/.test(phaseHint) || stagingAdvisoryPattern.test(allText)) {
    return rootCauseRecord(
      "staging-advisory-seed-or-e2e",
      input,
      steps,
      text,
      providerOverridesForMatch(steps, text, stagingAdvisoryPattern),
    );
  }
  if (/staging-browser-install/.test(phaseHint) || stagingBrowserInstallPattern.test(allText)) {
    return rootCauseRecord(
      "staging-browser-install",
      input,
      steps,
      text,
      providerOverridesForMatch(steps, text, stagingBrowserInstallPattern),
    );
  }
  if (/staging-verification|blocking-staging/.test(phaseHint) || stagingVerificationPattern.test(allText)) {
    return rootCauseRecord(
      "blocking-staging-verification",
      input,
      steps,
      text,
      providerOverridesForMatch(steps, text, stagingVerificationPattern),
    );
  }
  if (/production-verification/.test(phaseHint)) {
    return rootCauseRecord("production-verification", input, steps, text);
  }
  return rootCauseRecord("unknown", input, steps, text);
}

export function renderDeployRootCauseSummary(rootCause) {
  return `## Deployment root cause

- Code: \`${rootCause.rootCauseCode}\`
- Summary: ${rootCause.rootCauseSummary}
- Affected component: ${rootCause.affectedComponent}
- Phase: ${rootCause.phase}
- Provider reason: ${rootCause.providerReason}
- Remediation: ${rootCause.remediation}`;
}

export function parsePlatformDeployIncidentOptions(argv, env = process.env) {
  return {
    command: readOption(argv, "--command") ?? readEnv("PLATFORM_DEPLOY_INCIDENT_COMMAND", env) ?? "classify-run",
    format: readOption(argv, "--format") ?? readEnv("PLATFORM_DEPLOY_INCIDENT_FORMAT", env) ?? "json",
    diagnosticsPaths: readRepeatedOptions(argv, "--diagnostics"),
    classificationPhase: readOption(argv, "--phase") ?? readEnv("DEPLOY_ROOT_CAUSE_PHASE", env) ?? "",
    outPath: readOption(argv, "--out") ?? readEnv("DEPLOY_ROOT_CAUSE_OUT", env) ?? "",
    githubSummary: readOption(argv, "--github-summary") ?? readEnv("GITHUB_STEP_SUMMARY", env) ?? "",
    resolveReleaseResult: readOption(argv, "--resolve-release-result") ?? readEnv("RESOLVE_RELEASE_RESULT", env),
    buildImageResult: readOption(argv, "--build-image-result") ?? readEnv("BUILD_IMAGE_RESULT", env),
    deployStagingResult: readOption(argv, "--deploy-staging-result") ?? readEnv("DEPLOY_STAGING_RESULT", env),
    stagingApplied: readOption(argv, "--staging-applied") ?? readEnv("STAGING_APPLIED", env),
    stagingDeployed: readOption(argv, "--staging-deployed") ?? readEnv("STAGING_DEPLOYED", env),
    deployProductionResult: readOption(argv, "--deploy-production-result") ?? readEnv("DEPLOY_PRODUCTION_RESULT", env),
    productionSuperseded: readOption(argv, "--production-superseded") ?? readEnv("PRODUCTION_SUPERSEDED", env),
    recordStagingHealthResult:
      readOption(argv, "--record-staging-health-result") ?? readEnv("RECORD_STAGING_HEALTH_RESULT", env),
    stagingRootCauseCode:
      readOption(argv, "--staging-root-cause-code") ??
      readEnv("STAGING_ROOT_CAUSE_CODE", env) ??
      readEnv("STAGING_FAILURE_CLASSIFICATION", env) ??
      "",
    productionRootCauseCode:
      readOption(argv, "--production-root-cause-code") ?? readEnv("PRODUCTION_ROOT_CAUSE_CODE", env) ?? "",
    rootCauseSummary: readOption(argv, "--root-cause-summary") ?? readEnv("ROOT_CAUSE_SUMMARY", env) ?? "",
    affectedComponent: readOption(argv, "--affected-component") ?? readEnv("AFFECTED_COMPONENT", env) ?? "",
    rootCausePhase: readOption(argv, "--root-cause-phase") ?? readEnv("ROOT_CAUSE_PHASE", env) ?? "",
    remediation: readOption(argv, "--remediation") ?? readEnv("ROOT_CAUSE_REMEDIATION", env) ?? "",
    providerReason: readOption(argv, "--provider-reason") ?? readEnv("ROOT_CAUSE_PROVIDER_REASON", env) ?? "",
    rootCauseSignature: readOption(argv, "--root-cause-signature") ?? readEnv("ROOT_CAUSE_SIGNATURE", env) ?? "",
    title: readOption(argv, "--title") ?? readEnv("INCIDENT_TITLE", env) ?? "",
    body: readOption(argv, "--body") ?? readEnv("INCIDENT_BODY", env) ?? "",
    runUrl: readOption(argv, "--run-url") ?? readEnv("RUN_URL", env) ?? "",
    artifactsUrl: readOption(argv, "--artifacts-url") ?? readEnv("ARTIFACTS_URL", env) ?? "",
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env) ?? "",
    supersededByCommit: readOption(argv, "--superseded-by-commit") ?? readEnv("SUPERSEDED_BY_COMMIT", env) ?? "",
    reason: readOption(argv, "--reason") ?? readEnv("PLATFORM_DEPLOY_INCIDENT_REASON", env) ?? "",
  };
}

function rootCauseFromCode(code, input = {}) {
  const stableCode = DEPLOY_ROOT_CAUSE_CODES.includes(code) ? code : "unknown";
  const rootCause = rootCauseRecord(stableCode, input, [], "", {
    affectedComponent: input.affectedComponent,
    phase: input.rootCausePhase,
    providerReason: input.providerReason,
  });
  return {
    ...rootCause,
    rootCauseSummary: input.rootCauseSummary || rootCause.rootCauseSummary,
    remediation: input.remediation || rootCause.remediation,
    rootCauseSignature: input.rootCauseSignature || rootCause.rootCauseSignature,
  };
}

export function classifyPlatformDeployRun(input = {}) {
  const successfulPrerequisites = [
    input.resolveReleaseResult,
    input.buildImageResult,
    input.deployStagingResult,
    input.recordStagingHealthResult,
  ].every((result) => result === "success");
  const productionSuperseded = parseBoolean(input.productionSuperseded) === true;
  const stagingApplied = parseBoolean(input.stagingApplied);
  const stagingDeployed = parseBoolean(input.stagingDeployed);
  const stagingWasNotApplied = stagingApplied === false || (stagingApplied === null && stagingDeployed === false);
  const legacyStagingNoOp =
    stagingApplied === null &&
    stagingDeployed === null &&
    input.deployStagingResult === "success" &&
    input.deployProductionResult === "skipped";
  const stagingSuperseded =
    input.deployStagingResult === "success" &&
    input.deployProductionResult === "skipped" &&
    (stagingWasNotApplied || legacyStagingNoOp);
  const supersededNoOp = successfulPrerequisites && (productionSuperseded || stagingSuperseded);

  let rootCause;
  if (supersededNoOp) {
    rootCause = rootCauseFromCode("superseded-pre-mutation", input);
  } else if (input.deployStagingResult === "failure") {
    const legacyCode = /bootstrap|migration/.test(input.stagingRootCauseCode)
      ? "doks-bootstrap-or-migration"
      : input.stagingRootCauseCode;
    rootCause = rootCauseFromCode(legacyCode, input);
  } else if (input.deployProductionResult === "failure") {
    rootCause = rootCauseFromCode(input.productionRootCauseCode || "production-verification", input);
  } else {
    rootCause = rootCauseFromCode("unknown", input);
  }

  return {
    schemaVersion: PLATFORM_DEPLOY_INCIDENT_VERSION,
    action: supersededNoOp ? "close" : "create-or-update",
    kind: supersededNoOp ? "superseded-no-op" : "deploy-failure",
    noOp: supersededNoOp,
    reason: rootCause.rootCauseCode,
    ...rootCause,
  };
}

export function buildDeployIncidentBody(input = {}) {
  const rootCause = rootCauseFromCode(input.rootCauseCode || input.reason, input);
  return `Automated production deploy incident signal.

- Root cause: \`${rootCause.rootCauseCode}\`
- Summary: ${input.rootCauseSummary || rootCause.rootCauseSummary}
- Affected component: ${input.affectedComponent || rootCause.affectedComponent}
- Phase: ${input.rootCausePhase || rootCause.phase}
- Provider reason: ${boundedProviderReason(input.providerReason || rootCause.providerReason)}
- Workflow run: ${input.runUrl || "unavailable"}
- Release commit: ${input.releaseCommit || "unavailable"}
- Diagnostics artifacts: ${input.artifactsUrl || "unavailable"}

Remediation: ${input.remediation || rootCause.remediation}

This signal is keyed by root-cause signature \`${input.rootCauseSignature || rootCause.rootCauseSignature}\`. Repeated active failures add per-run evidence here without hiding a different root cause.`;
}

export function classifySupersededNoOpIncident({ title = "", body = "" } = {}) {
  const hasSupersededTitle = title.startsWith(NO_OP_INCIDENT_TITLE_PREFIX);
  const hasSupersededKind = /(?:^|\n)\s*-\s*Kind:\s*production-superseded\s*$/im.test(body);
  const hasSupersedingCommit = /(?:^|\n)\s*-\s*Superseded by commit:\s*[0-9a-f]{40}\s*$/im.test(body);

  return {
    action: hasSupersededTitle && hasSupersededKind && hasSupersedingCommit ? "close" : "leave-open",
    noOp: hasSupersededTitle && hasSupersededKind && hasSupersedingCommit,
  };
}

export function buildSupersededNoOpResolutionComment({
  runUrl = "",
  releaseCommit = "",
  supersededByCommit = "",
  reason = "",
} = {}) {
  return `Automated Platform Deploy no-op resolution.

- Resolving workflow run: ${runUrl || "unavailable"}
- Superseded release commit: ${releaseCommit || "unavailable"}
- Superseding commit: ${supersededByCommit || "unavailable"}
- Classification: ${reason || "superseded-pre-mutation"}

This deploy run was intentionally superseded before its release was applied. The newer release owns the deploy lane, so no failed deploy action remains for this incident.`;
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function writeResult(result, format) {
  if (format === "plain") {
    process.stdout.write(`${result.action ?? result}\n`);
    return;
  }
  if (format === "github-output") {
    for (const [key, value] of Object.entries(result)) {
      if (typeof value !== "object") {
        const outputKey = key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
        process.stdout.write(`${outputKey}=${value}\n`);
      }
    }
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export function readDeployDiagnostics(paths) {
  return paths.flatMap((path) => {
    try {
      const content = readFileSync(path, "utf8");
      try {
        return [JSON.parse(content)];
      } catch {
        return [content];
      }
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      return [{ diagnosticReadError: boundedProviderReason(error instanceof Error ? error.message : error) }];
    }
  });
}

async function runCli() {
  const options = parsePlatformDeployIncidentOptions(process.argv.slice(2));
  if (options.command === "classify-root-cause") {
    const diagnostics = readDeployDiagnostics(options.diagnosticsPaths);
    const steps = diagnostics.flatMap((diagnostic) => diagnostic.steps ?? []);
    const logs = diagnostics.flatMap((diagnostic) => diagnostic.logs ?? []);
    const result = classifyDeploymentRootCause({ phase: options.classificationPhase, diagnostics, steps, logs });
    if (options.outPath) await writeJsonRecord(options.outPath, result);
    if (options.githubSummary) appendFileSync(options.githubSummary, `${renderDeployRootCauseSummary(result)}\n`);
    writeResult(result, options.format);
    return;
  }
  if (options.command === "classify-run") {
    writeResult(classifyPlatformDeployRun(options), options.format);
    return;
  }
  if (options.command === "classify-issue") {
    writeResult(classifySupersededNoOpIncident(options), options.format);
    return;
  }
  if (options.command === "build-incident-body") {
    process.stdout.write(`${buildDeployIncidentBody({ ...options, rootCauseCode: options.reason })}\n`);
    return;
  }
  if (options.command === "build-comment") {
    process.stdout.write(`${buildSupersededNoOpResolutionComment(options)}\n`);
    return;
  }
  throw new Error(`Unknown platform deploy incident command: ${options.command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli();
}
