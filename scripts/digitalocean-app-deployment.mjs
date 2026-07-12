import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { writeJsonRecord } from "./lib/output-file.mjs";

const TERMINAL_DEPLOYMENT_PHASES = new Set(["ACTIVE", "ERROR", "CANCELED", "CANCELLED", "SUPERSEDED"]);

const ACTIVE_DOMAIN_PHASE = "ACTIVE";
const DEFAULT_DEPLOYMENT_LOG_TYPES = ["deploy", "run", "run_restarted"];
const DIGITALOCEAN_API_BASE_URL = "https://api.digitalocean.com/v2";
const DEPLOYMENT_SUMMARY_API_PAGE_SIZE = 20;
const DEPLOYMENT_SUMMARY_FIELDS = "ID,Phase,Updated";
const MAX_DIAGNOSTIC_ERROR_MESSAGE_LENGTH = 2_000;
const APP_SPEC_IMAGE_COLLECTIONS = ["jobs", "services", "workers", "static_sites", "functions"];
const ROLLBACK_TARGET_SCHEMA_VERSION = "digitalocean-app-rollback-target/v1";
const DURABLE_DATABASE_DESTRUCTIVE_RESOURCE_NAMES = new Map([
  ["digitalocean_database_cluster", new Set(["postgres"])],
  ["digitalocean_database_db", new Set(["contexts"])],
  ["digitalocean_database_user", new Set(["contexts", "wake_listeners"])],
  ["digitalocean_database_connection_pool", new Set(["contexts"])],
]);

function truncateDiagnosticMessage(message, maxLength = MAX_DIAGNOSTIC_ERROR_MESSAGE_LENGTH) {
  if (message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, maxLength)}\n... truncated ${message.length - maxLength} characters ...`;
}

function diagnosticErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return truncateDiagnosticMessage(message);
}

function createCommandError(command, args, message, details = {}) {
  const error = new Error(`${command} ${args.join(" ")} failed: ${truncateDiagnosticMessage(message)}`);
  Object.assign(error, details);
  return error;
}

function commandOutput(command, args, options = {}) {
  if (options.input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true });
      const stdoutChunks = [];
      const stderrChunks = [];

      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0) {
          const message = stderr.trim() || stdout.trim() || `${command} exited with code ${code}`;
          reject(createCommandError(command, args, message, { exitCode: code, stdout, stderr }));
          return;
        }

        resolve(stdout);
      });

      child.stdin.end(options.input);
    });
  }

  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { maxBuffer: 50 * 1024 * 1024, timeout: options.timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || stdout.trim() || error.message;
          reject(
            createCommandError(command, args, message, { exitCode: error.code, signal: error.signal, stdout, stderr }),
          );
          return;
        }

        resolve(stdout);
      },
    );
  });
}

async function commandJson(command, args, options = {}) {
  try {
    const output = await (options.commandOutput ?? commandOutput)(command, args);
    return JSON.parse(output);
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    if (options.allowNonzeroJsonOutput && stdout) {
      try {
        return JSON.parse(stdout);
      } catch (parseError) {
        throw new Error(
          `Unable to parse JSON stdout from failed ${command} ${args.join(" ")} command: ${diagnosticErrorMessage(parseError)}`,
        );
      }
    }

    throw error;
  }
}

function parsePositiveIntegerArg(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readOption(argv, name, defaultValue) {
  const prefix = `${name}=`;
  const value = argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return value === undefined ? defaultValue : parsePositiveIntegerArg(value, name);
}

function readStringOption(argv, name, defaultValue = undefined) {
  const prefix = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? defaultValue;
}

function readStringOptions(argv, name) {
  const prefix = `${name}=`;
  return argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

function normalizeDeployment(deployment) {
  return {
    id: deployment.id ?? deployment.ID ?? "",
    phase: deployment.phase ?? deployment.Phase ?? "",
  };
}

function normalizeDeploymentSummary(deployment) {
  return {
    id: deployment.id ?? deployment.ID ?? "",
    phase: deployment.phase ?? deployment.Phase ?? deployment.status ?? deployment.Status ?? "",
    createdAt: deployment.created_at ?? deployment.createdAt ?? deployment.Created ?? "",
    updatedAt: deployment.updated_at ?? deployment.updatedAt ?? deployment.Updated ?? "",
  };
}

function normalizeDomain(domain) {
  return {
    name: domain.spec?.domain ?? domain.domain ?? domain.name ?? "",
    phase: domain.phase ?? "",
  };
}

function normalizeAppResponse(appResponse) {
  return Array.isArray(appResponse) ? appResponse[0] : appResponse;
}

function normalizeDeploymentResponse(deploymentResponse) {
  return Array.isArray(deploymentResponse) ? deploymentResponse[0] : deploymentResponse;
}

function timestampValue(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function listDeploymentsSummaryArgs(appId) {
  return ["apps", "list-deployments", appId, "--format", DEPLOYMENT_SUMMARY_FIELDS, "--no-header"];
}

function deploymentSummaryFromApi(deployment) {
  return {
    id: deployment?.id ?? "",
    phase: deployment?.phase ?? "",
    createdAt: deployment?.created_at ?? deployment?.createdAt ?? "",
    updatedAt: deployment?.updated_at ?? deployment?.updatedAt ?? "",
  };
}

async function digitalOceanApiJson(path, options = {}) {
  const accessToken = options.accessToken ?? process.env.DIGITALOCEAN_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("DIGITALOCEAN_ACCESS_TOKEN is required for DigitalOcean API requests.");
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("A fetch implementation is required for DigitalOcean API requests.");
  }

  const apiBaseUrl = options.apiBaseUrl ?? process.env.DIGITALOCEAN_API_BASE_URL ?? DIGITALOCEAN_API_BASE_URL;
  const response = await fetchImpl(`${apiBaseUrl}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `DigitalOcean App Platform API request failed with ${response.status} ${response.statusText}: ${truncateDiagnosticMessage(body)}`,
    );
  }

  return response.json();
}

export async function listDeploymentSummariesFromApi(appId, options = {}) {
  const pageSize = options.pageSize ?? DEPLOYMENT_SUMMARY_API_PAGE_SIZE;
  const json = await digitalOceanApiJson(
    `/apps/${encodeURIComponent(appId)}/deployments?per_page=${pageSize}&page=1`,
    options,
  );

  return (json.deployments ?? []).map(deploymentSummaryFromApi).filter((deployment) => deployment.id);
}

async function listDeploymentSummaries(appId, options = {}) {
  if (!options.commandOutput && (options.accessToken ?? process.env.DIGITALOCEAN_ACCESS_TOKEN)) {
    return listDeploymentSummariesFromApi(appId, options);
  }

  const command = options.commandOutput ?? commandOutput;
  return parseDeploymentSummaryRows(await command("doctl", listDeploymentsSummaryArgs(appId)));
}

export function parseDeploymentSummaryRows(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", phase = "", ...updatedParts] = line.split(/\s+/);
      return { id, phase, createdAt: "", updatedAt: updatedParts.join(" ") };
    })
    .filter((deployment) => deployment.id && deployment.id !== "ID");
}

function componentNamesFromSpecCollection(collection) {
  return (collection ?? []).map((component) => component?.name).filter((name) => typeof name === "string" && name);
}

function deploymentProgressSteps(deployment) {
  const progress = deployment?.progress ?? deployment?.Progress ?? {};
  return progress.steps ?? progress.Steps ?? [];
}

function normalizeDiagnosticStep(step) {
  return {
    name: step.name ?? step.Name ?? step.component_name ?? step.componentName ?? "unnamed-step",
    status: step.status ?? step.Status ?? step.phase ?? step.Phase ?? "unknown",
    reason: step.reason?.message ?? step.reason?.code ?? step.Reason?.Message ?? step.Reason?.Code ?? "",
  };
}

function diagnosticStepIsBootstrapFailure(step) {
  return (
    /platform-bootstrap/i.test(step.name) &&
    /DeployContainerExitNonZero/i.test(step.reason) &&
    /error|failed/i.test(step.status)
  );
}

function redactDiagnosticOutput(output) {
  return String(output ?? "")
    .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/(postgres(?:ql)?:\/\/)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:gho_|ghp_|dop_v1_|sk_(?:live|test)_)[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
    .replace(/((?:password|secret|token|api[_-]?key|cookie|database[_-]?url)\s*[=:]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
}

export function buildDeploymentDiagnosticsRecord(options = {}) {
  const steps = (options.steps ?? []).map(normalizeDiagnosticStep);
  return {
    schemaVersion: "digitalocean-app-deployment-diagnostics/v1",
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    appId: options.appId ?? "",
    deploymentId: options.deploymentId ?? "",
    deploymentPhase: options.deploymentPhase ?? "",
    componentNames: [...(options.componentNames ?? [])].sort(),
    logTypes: [...(options.logTypes ?? [])].sort(),
    bootstrapFailure: steps.some(diagnosticStepIsBootstrapFailure),
    steps,
    logs: (options.logs ?? []).map((entry) => ({
      componentName: entry.componentName,
      logType: entry.logType,
      ok: entry.ok,
      ...(entry.ok
        ? {
            output: redactDiagnosticOutput(entry.output),
          }
        : { error: redactDiagnosticOutput(entry.error) }),
    })),
  };
}

function domainReasonCodes(domain) {
  return new Set(
    (domain?.progress?.steps ?? [])
      .map((step) => step.reason?.code)
      .filter((code) => typeof code === "string" && code.length > 0),
  );
}

function staleDomainAttachment(domain) {
  if (!domain || domain.phase === ACTIVE_DOMAIN_PHASE) {
    return false;
  }

  const reasonCodes = domainReasonCodes(domain);
  return reasonCodes.has("DomainZoneInvalid") || reasonCodes.has("DomainCNAMEMismatch");
}

function cloneSpec(spec) {
  return JSON.parse(JSON.stringify(spec));
}

function componentImageEntries(spec, repository = "") {
  const entries = [];
  const expectedRepository = String(repository ?? "").trim();

  for (const collectionName of APP_SPEC_IMAGE_COLLECTIONS) {
    for (const component of spec?.[collectionName] ?? []) {
      const image = component?.image;
      if (!image || typeof image !== "object") {
        continue;
      }

      if (expectedRepository && image.repository !== expectedRepository) {
        continue;
      }

      entries.push({
        collectionName,
        componentName: component.name ?? "",
        image,
      });
    }
  }

  return entries;
}

function imageIdentity(image) {
  const { tag, digest } = imageRollbackReference(image);
  return JSON.stringify({
    registryType: image.registry_type ?? "",
    repository: image.repository ?? "",
    tag,
    digest,
  });
}

function imageRollbackReference(image) {
  return {
    tag: image.tag ?? image.deploy_on_push?.tag ?? "",
    digest: image.digest ?? "",
  };
}

function imageReference({ registryName, repository, tag, digest }) {
  const registry = String(registryName ?? "").trim();
  if (!registry) {
    throw new Error("A DigitalOcean registry name is required to build the rollback image reference.");
  }

  if (digest) {
    return `registry.digitalocean.com/${registry}/${repository}@${digest}`;
  }

  return `registry.digitalocean.com/${registry}/${repository}:${tag}`;
}

function writeGithubOutput(filePath, values) {
  if (!filePath) {
    return;
  }

  appendFileSync(
    filePath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value ?? ""}`)
      .join("\n")}\n`,
  );
}

function removeDomainAttachment(spec, hostname) {
  const nextSpec = cloneSpec(spec);
  nextSpec.domains = (nextSpec.domains ?? []).filter((domain) => domain.domain !== hostname);
  nextSpec.ingress = nextSpec.ingress ?? {};
  nextSpec.ingress.rules = (nextSpec.ingress.rules ?? []).filter((rule) => rule?.match?.authority?.exact !== hostname);
  return nextSpec;
}

function restoreDomainAttachment(spec, domainSpecs, hostname, ingressRules) {
  const nextSpec = cloneSpec(spec);
  const restoredDomainNames = new Set(domainSpecs.map((domain) => domain.domain));
  nextSpec.domains = (nextSpec.domains ?? []).filter((domain) => !restoredDomainNames.has(domain.domain));
  nextSpec.domains.push(...domainSpecs);

  nextSpec.ingress = nextSpec.ingress ?? {};
  nextSpec.ingress.rules = (nextSpec.ingress.rules ?? []).filter((rule) => rule?.match?.authority?.exact !== hostname);

  const insertAt = nextSpec.ingress.rules.findIndex((rule) => !rule?.match?.authority?.exact);
  nextSpec.ingress.rules.splice(insertAt >= 0 ? insertAt : nextSpec.ingress.rules.length, 0, ...ingressRules);
  return nextSpec;
}

export function appPlatformChanges(plan) {
  return Boolean(
    plan.resource_changes?.some((resourceChange) => {
      if (resourceChange.type !== "digitalocean_app" || resourceChange.name !== "platform") {
        return false;
      }

      const actions = resourceChange.change?.actions ?? [];
      return actions.length > 0 && actions.some((action) => action !== "no-op");
    }),
  );
}

export function terraformPlanSummary(plan, options = {}) {
  const maxResources = options.maxResources ?? 50;
  const changes = (plan.resource_changes ?? [])
    .map((resourceChange) => {
      const actions = resourceChange.change?.actions ?? [];
      return {
        address: resourceChange.address ?? `${resourceChange.type}.${resourceChange.name}`,
        actions,
      };
    })
    .filter(
      (change) => change.actions.length > 0 && change.actions.some((action) => !["no-op", "read"].includes(action)),
    );

  return {
    add: changes.filter((change) => change.actions.includes("create")).length,
    change: changes.filter((change) => change.actions.includes("update")).length,
    destroy: changes.filter((change) => change.actions.includes("delete")).length,
    resources: changes
      .sort((left, right) => left.address.localeCompare(right.address))
      .slice(0, maxResources)
      .map((change) => ({ ...change, actions: [...change.actions] })),
    omittedResources: Math.max(0, changes.length - maxResources),
  };
}

export function renderTerraformPlanSummaryMarkdown(plan, options = {}) {
  const title = options.title ?? "Terraform plan";
  const summary = terraformPlanSummary(plan, { maxResources: options.maxResources });
  const lines = [
    `### ${title}`,
    "",
    `- Add: ${summary.add}`,
    `- Change: ${summary.change}`,
    `- Destroy: ${summary.destroy}`,
    "",
  ];

  if (summary.resources.length === 0) {
    lines.push("No resource changes in this plan.");
  } else {
    lines.push("Changed resources:");
    for (const resource of summary.resources) {
      lines.push(`- \`${resource.address}\` (${resource.actions.join(", ")})`);
    }
    if (summary.omittedResources > 0) {
      lines.push(`- ... ${summary.omittedResources} additional resource change(s) omitted from the summary.`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function knownTerraformId(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function postgresClusterResourceId(resource) {
  if (resource?.type !== "digitalocean_database_cluster" || resource?.name !== "postgres") {
    return "";
  }

  return knownTerraformId(resource.values?.id);
}

function modulePostgresClusterId(module) {
  for (const resource of module?.resources ?? []) {
    const id = postgresClusterResourceId(resource);
    if (id) {
      return id;
    }
  }

  for (const childModule of module?.child_modules ?? []) {
    const id = modulePostgresClusterId(childModule);
    if (id) {
      return id;
    }
  }

  return "";
}

export function postgresClusterIdFromPlan(plan) {
  for (const resourceChange of plan.resource_changes ?? []) {
    if (resourceChange.type !== "digitalocean_database_cluster" || resourceChange.name !== "postgres") {
      continue;
    }

    const id =
      knownTerraformId(resourceChange.change?.after?.id) || knownTerraformId(resourceChange.change?.before?.id);
    if (id) {
      return id;
    }
  }

  return (
    modulePostgresClusterId(plan.planned_values?.root_module) ||
    modulePostgresClusterId(plan.prior_state?.values?.root_module)
  );
}

export function destructiveResourceChanges(plan) {
  return (plan.resource_changes ?? [])
    .filter((resourceChange) => {
      if (resourceChange.type === "terraform_data") {
        return false;
      }

      const actions = resourceChange.change?.actions ?? [];
      return actions.includes("delete");
    })
    .map((resourceChange) => ({
      address: resourceChange.address ?? `${resourceChange.type}.${resourceChange.name}`,
      type: resourceChange.type ?? "",
      name: resourceChange.name ?? "",
      actions: resourceChange.change?.actions ?? [],
    }));
}

function durableDatabaseDestructiveResource(change) {
  const names = DURABLE_DATABASE_DESTRUCTIVE_RESOURCE_NAMES.get(change.type);
  const baseName = change.name.split("[")[0];
  return names?.has(baseName) ?? false;
}

export function durableDatabaseDestructiveResourceChanges(plan) {
  return destructiveResourceChanges(plan).filter(durableDatabaseDestructiveResource);
}

const DESTRUCTIVE_APPROVAL_STATE_ACTIVE = "active";
const DESTRUCTIVE_APPROVAL_STATE_NONE = "no-active-approval";

function destructiveApprovalField(text, label) {
  return new RegExp(`^${label}:\\s*(.+?)\\s*$`, "m").exec(text)?.[1]?.trim() ?? "";
}

export function destructiveChangesApprovalFingerprint(changes) {
  const fingerprintInput = changes
    .map((change) => ({
      address: change.address,
      actions: [...change.actions].sort(),
    }))
    .sort((left, right) => left.address.localeCompare(right.address));

  return `sha256:${createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex")}`;
}

export function destructiveChangeApprovalFromText(text) {
  const state = destructiveApprovalField(text, "Approval state");
  if (state === DESTRUCTIVE_APPROVAL_STATE_NONE) {
    return { state, planFingerprint: "", addresses: [] };
  }
  if (state !== DESTRUCTIVE_APPROVAL_STATE_ACTIVE) {
    throw new Error(
      "Production destructive-change approval must declare 'Approval state: active' or 'Approval state: no-active-approval'.",
    );
  }

  const planFingerprint = destructiveApprovalField(text, "Plan fingerprint");
  if (!/^sha256:[a-f0-9]{64}$/.test(planFingerprint)) {
    throw new Error("Active production destructive-change approval must include a current Plan fingerprint.");
  }

  const headingMatch = /^## Approved Destructive Changes\s*$/m.exec(text);
  if (!headingMatch) {
    throw new Error("Production destructive-change approval must include an 'Approved Destructive Changes' section.");
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const sectionTail = text.slice(sectionStart);
  const nextHeadingIndex = sectionTail.search(/\n##\s+/);
  const section = nextHeadingIndex >= 0 ? sectionTail.slice(0, nextHeadingIndex) : sectionTail;
  const addresses = section
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+`([^`]+)`\s*$/)?.[1])
    .filter((address) => typeof address === "string" && address.length > 0);

  if (addresses.length === 0) {
    throw new Error("Production destructive-change approval must list at least one exact Terraform resource address.");
  }

  return { state, planFingerprint, addresses: [...new Set(addresses)] };
}

export function approvedDestructiveChangeAddressesFromText(text) {
  return destructiveChangeApprovalFromText(text).addresses;
}

export function readDestructiveChangeAllowFile(filePath) {
  return destructiveChangeApprovalFromText(readFileSync(filePath, "utf8"));
}

export function assertNoDestructiveChanges(plan, options = {}) {
  const destructiveChanges = destructiveResourceChanges(plan);
  if (destructiveChanges.length === 0) {
    return destructiveChanges;
  }

  const durableDatabaseChanges = destructiveChanges.filter(durableDatabaseDestructiveResource);
  const approval = options.destructiveChangeApproval;
  const allowedDestructiveAddresses = approval?.addresses ?? options.allowedDestructiveAddresses ?? [];

  if (allowedDestructiveAddresses.length > 0) {
    if (approval) {
      const expectedFingerprint = destructiveChangesApprovalFingerprint(destructiveChanges);
      if (approval.planFingerprint !== expectedFingerprint) {
        throw new Error(
          `Production destructive-change approval plan fingerprint does not match the current Terraform plan. Expected ${expectedFingerprint}.`,
        );
      }
    }

    const allowed = new Set(allowedDestructiveAddresses);
    const unapprovedChanges = destructiveChanges.filter((change) => !allowed.has(change.address));

    if (unapprovedChanges.length > 0) {
      const summary = unapprovedChanges.map((change) => `- ${change.address}: ${change.actions.join(",")}`).join("\n");
      throw new Error(
        `Production Terraform plan contains destructive changes not covered by the reviewed override marker:\n${summary}`,
      );
    }

    console.warn("Production destructive-change override marker is present for these resources:");
    for (const change of destructiveChanges) {
      console.warn(`- ${change.address}: ${change.actions.join(",")}`);
    }
    return destructiveChanges;
  }

  if (durableDatabaseChanges.length > 0) {
    const summary = durableDatabaseChanges
      .map((change) => `- ${change.address}: ${change.actions.join(",")}`)
      .join("\n");
    throw new Error(
      `Production Terraform plan would delete durable database resources without an audited resource-scoped emergency override:\n${summary}\nExpected paths: use profile gating or retained context provisioning for runtime posture changes, PITR/restore procedures for recovery, or a reviewed production destructive-change approval marker that names each exact resource address.`,
    );
  }

  if (options.allowDestructiveChanges) {
    console.warn("Production destructive-change override marker is present.");
    for (const change of destructiveChanges) {
      console.warn(`- ${change.address}: ${change.actions.join(",")}`);
    }
    return destructiveChanges;
  }

  const summary = destructiveChanges.map((change) => `- ${change.address}: ${change.actions.join(",")}`).join("\n");
  throw new Error(
    `Production Terraform plan contains destructive changes and no reviewed override marker was found:\n${summary}`,
  );
}

export function activeDeployments(deployments) {
  return deployments.map(normalizeDeployment).filter((deployment) => !TERMINAL_DEPLOYMENT_PHASES.has(deployment.phase));
}

export function latestDeployment(deployments) {
  return [...deployments]
    .map(normalizeDeploymentSummary)
    .filter((deployment) => deployment.id)
    .sort((left, right) => {
      const updatedDelta = timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
      if (updatedDelta !== 0) {
        return updatedDelta;
      }

      return timestampValue(right.createdAt) - timestampValue(left.createdAt);
    })[0];
}

export function deploymentForDiagnostics(deployments) {
  const summaries = deployments.map(normalizeDeploymentSummary).filter((deployment) => deployment.id);
  const failed = summaries.filter((deployment) => deployment.phase === "ERROR");
  return latestDeployment(failed.length > 0 ? failed : summaries);
}

export function deploymentComponentNames(app) {
  const spec = app?.spec ?? {};
  return [
    ...new Set([
      ...componentNamesFromSpecCollection(spec.jobs),
      ...componentNamesFromSpecCollection(spec.services),
      ...componentNamesFromSpecCollection(spec.workers),
      ...componentNamesFromSpecCollection(spec.static_sites),
      ...componentNamesFromSpecCollection(spec.functions),
    ]),
  ];
}

export function appRollbackTarget(app, options = {}) {
  const entries = componentImageEntries(app?.spec ?? {}, options.repository);
  if (entries.length === 0) {
    throw new Error(
      options.repository
        ? `App Platform app does not contain image components for repository '${options.repository}'.`
        : "App Platform app does not contain image components.",
    );
  }

  const identities = new Set(entries.map((entry) => imageIdentity(entry.image)));
  if (identities.size !== 1) {
    const summary = entries
      .map((entry) => `- ${entry.componentName || entry.collectionName}: ${imageIdentity(entry.image)}`)
      .join("\n");
    throw new Error(`App Platform image components do not share a single rollback target:\n${summary}`);
  }

  const image = entries[0].image;
  const repository = image.repository ?? "";
  const { tag, digest } = imageRollbackReference(image);
  if (!repository) {
    throw new Error("Rollback target image repository is missing from the App Platform spec.");
  }
  if (!tag && !digest) {
    throw new Error("Rollback target image must include a tag or digest in the App Platform spec.");
  }

  return {
    schemaVersion: ROLLBACK_TARGET_SCHEMA_VERSION,
    capturedAt: options.checkedAt ?? new Date().toISOString(),
    appId: app?.id ?? app?.ID ?? "",
    appName: app?.spec?.name ?? app?.name ?? "",
    registryName: options.registryName ?? "",
    repository,
    tag,
    digest,
    imageRef: imageReference({ registryName: options.registryName, repository, tag, digest }),
    componentNames: entries.map((entry) => entry.componentName || entry.collectionName).sort(),
    lastKnownGoodCommit: options.lastKnownGoodCommit ?? "",
    releaseTag: options.releaseTag ?? "",
  };
}

export function rollbackSpecToImage(spec, target, options = {}) {
  const nextSpec = cloneSpec(spec);
  const entries = componentImageEntries(nextSpec, options.repository ?? target.repository);
  if (entries.length === 0) {
    throw new Error(`App Platform spec does not contain image components for repository '${target.repository}'.`);
  }

  if (!target.digest && !target.tag) {
    throw new Error("Rollback target image must include a digest or tag.");
  }

  for (const entry of entries) {
    entry.image.repository = target.repository;
    if (target.digest) {
      entry.image.digest = target.digest;
      delete entry.image.tag;
    } else {
      entry.image.tag = target.tag;
      delete entry.image.digest;
    }
  }

  return nextSpec;
}

export function pendingDomains(app, hostnames) {
  const expected = new Set(hostnames);
  const domains = (app.domains ?? []).map(normalizeDomain);
  const byName = new Map(domains.map((domain) => [domain.name, domain]));

  return [...expected]
    .map((hostname) => byName.get(hostname) ?? { name: hostname, phase: "MISSING" })
    .filter((domain) => domain.phase !== ACTIVE_DOMAIN_PHASE);
}

export function appNotFound(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:not found|404|does not exist|could not find)/i.test(message) && /\bapp(?:s| platform)?\b/i.test(message);
}

export async function planAppChanged(tfplanPath, options = {}) {
  const output = await (options.commandOutput ?? commandOutput)("terraform", ["show", "-json", tfplanPath]);
  return appPlatformChanges(JSON.parse(output));
}

export async function readPostgresClusterIdFromPlan(tfplanPath, options = {}) {
  const output = await (options.commandOutput ?? commandOutput)("terraform", ["show", "-json", tfplanPath]);
  return postgresClusterIdFromPlan(JSON.parse(output));
}

export async function assertTerraformPlanSafe(tfplanPath, options = {}) {
  const output = await (options.commandOutput ?? commandOutput)("terraform", ["show", "-json", tfplanPath]);
  return assertNoDestructiveChanges(JSON.parse(output), options);
}

export function readTerraformPlanSummaryMarkdown(tfplanJsonPath, options = {}) {
  return renderTerraformPlanSummaryMarkdown(JSON.parse(readFileSync(tfplanJsonPath, "utf8")), options);
}

export async function waitForDeployments(appId, options = {}) {
  const timeoutSeconds = options.timeoutSeconds ?? 1800;
  const pollSeconds = options.pollSeconds ?? 30;
  const now = options.now ?? (() => Date.now());
  const delay = options.sleep ?? sleep;
  const deadline = now() + timeoutSeconds * 1000;

  while (true) {
    let deployments;
    try {
      deployments = await listDeploymentSummaries(appId, options);
    } catch (error) {
      if (appNotFound(error)) {
        console.log(`App Platform app '${appId}' no longer exists; skipping deployment wait.`);
        return;
      }
      throw error;
    }

    const active = activeDeployments(deployments);

    if (active.length === 0) {
      console.log("No in-progress App Platform deployments remain.");
      return;
    }

    if (now() >= deadline) {
      const summary = active.map((deployment) => `- ${deployment.id}: ${deployment.phase}`).join("\n");
      throw new Error(`Timed out waiting for App Platform deployments to finish:\n${summary}`);
    }

    console.log("Waiting for App Platform deployment capacity:");
    for (const deployment of active) {
      console.log(`- ${deployment.id}: ${deployment.phase}`);
    }

    await delay(pollSeconds * 1000);
  }
}

export async function collectDeploymentDiagnostics(appId, options = {}) {
  const runJson = options.commandJson ?? commandJson;
  const command = options.commandOutput ?? commandOutput;
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const tailLines = options.tailLines ?? 200;
  const logTypes = options.logTypes?.length > 0 ? options.logTypes : DEFAULT_DEPLOYMENT_LOG_TYPES;
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  const jsonOptions = { ...options, allowNonzeroJsonOutput: true };

  let deployments = [];
  if (!options.deploymentId) {
    try {
      deployments = parseDeploymentSummaryRows(await command("doctl", listDeploymentsSummaryArgs(appId)));
    } catch (error) {
      warn(`Unable to list App Platform deployments for '${appId}': ${diagnosticErrorMessage(error)}`);
    }
  }

  const deployment = options.deploymentId
    ? { id: options.deploymentId, phase: "selected", createdAt: "", updatedAt: "" }
    : deploymentForDiagnostics(deployments);

  if (!deployment?.id) {
    warn(`No App Platform deployments were found for app '${appId}'; skipping deployment log diagnostics.`);
    return { deploymentId: "", logs: [] };
  }

  log(`App Platform deployment diagnostics for '${appId}':`);
  log(`- deployment: ${deployment.id}${deployment.phase ? ` (${deployment.phase})` : ""}`);

  let steps = [];
  try {
    const deploymentDetails = normalizeDeploymentResponse(
      await runJson("doctl", ["apps", "get-deployment", appId, deployment.id, "--output", "json"], jsonOptions),
    );
    steps = deploymentProgressSteps(deploymentDetails);

    if (steps.length > 0) {
      log("Deployment progress:");
      for (const step of steps) {
        const normalizedStep = normalizeDiagnosticStep(step);
        log(
          `- ${normalizedStep.name}: ${normalizedStep.status}${normalizedStep.reason ? ` - ${normalizedStep.reason}` : ""}`,
        );
      }
    }
  } catch (error) {
    warn(`Unable to load deployment progress for '${deployment.id}': ${diagnosticErrorMessage(error)}`);
  }

  let componentNames = options.componentNames ?? [];
  if (componentNames.length === 0) {
    try {
      const app = normalizeAppResponse(await runJson("doctl", ["apps", "get", appId, "--output", "json"], jsonOptions));
      componentNames = deploymentComponentNames(app);
    } catch (error) {
      warn(`Unable to load App Platform component names: ${diagnosticErrorMessage(error)}`);
    }
  }

  if (componentNames.length === 0) {
    warn("At least one App Platform component is required for deployment log diagnostics; skipping log collection.");
    return { deploymentId: deployment.id, logs: [] };
  }

  const collectedLogs = [];
  for (const componentName of componentNames) {
    for (const logType of logTypes) {
      const args = [
        "apps",
        "logs",
        appId,
        componentName,
        "--deployment",
        deployment.id,
        "--type",
        logType,
        "--tail",
        String(tailLines),
        "--no-prefix",
      ];

      log(`\n--- ${componentName} ${logType} logs (${deployment.id}) ---`);
      try {
        const output = await command("doctl", args, { timeoutMs: commandTimeoutMs });
        const trimmed = redactDiagnosticOutput(output.trim());
        log(trimmed || "(no log lines returned)");
        collectedLogs.push({ componentName, logType, ok: true, output });
      } catch (error) {
        const message = diagnosticErrorMessage(error);
        warn(`Unable to load ${componentName} ${logType} logs: ${message}`);
        collectedLogs.push({ componentName, logType, ok: false, error: message });
      }
    }
  }

  const result = { deploymentId: deployment.id, logs: collectedLogs };
  if (options.includeMetadata) {
    return {
      ...result,
      deploymentPhase: deployment.phase,
      componentNames,
      logTypes,
      steps,
    };
  }

  return result;
}

export async function waitForDomains(appId, hostnames, options = {}) {
  if (hostnames.length === 0) {
    throw new Error("At least one App Platform domain hostname is required.");
  }

  const timeoutSeconds = options.timeoutSeconds ?? 1800;
  const pollSeconds = options.pollSeconds ?? 30;
  const now = options.now ?? (() => Date.now());
  const delay = options.sleep ?? sleep;
  const runJson = options.commandJson ?? commandJson;
  const deadline = now() + timeoutSeconds * 1000;

  while (true) {
    const appResponse = await runJson("doctl", ["apps", "get", appId, "--output", "json"], options);
    const [app] = Array.isArray(appResponse) ? appResponse : [appResponse];
    const waiting = pendingDomains(app ?? {}, hostnames);

    if (waiting.length === 0) {
      console.log("All App Platform domains are active.");
      return;
    }

    if (now() >= deadline) {
      const summary = waiting.map((domain) => `- ${domain.name}: ${domain.phase}`).join("\n");
      throw new Error(`Timed out waiting for App Platform domains to become active:\n${summary}`);
    }

    console.log("Waiting for App Platform domains to become active:");
    for (const domain of waiting) {
      console.log(`- ${domain.name}: ${domain.phase}`);
    }

    await delay(pollSeconds * 1000);
  }
}

export async function resetStaleDomainAttachment(appId, hostname, options = {}) {
  const runJson = options.commandJson ?? commandJson;
  const command = options.commandOutput ?? commandOutput;
  const appResponse = await runJson("doctl", ["apps", "get", appId, "--output", "json"], options);
  const app = normalizeAppResponse(appResponse);
  const domain = (app?.domains ?? []).find((candidate) => normalizeDomain(candidate).name === hostname);

  if (!domain) {
    throw new Error(`App Platform domain '${hostname}' was not found on app '${appId}'.`);
  }

  if (!options.force && !staleDomainAttachment(domain)) {
    console.log(`App Platform domain '${hostname}' is not in a stale resettable state; skipping reset.`);
    return false;
  }

  const domainSpec = (app.spec?.domains ?? []).find((candidate) => candidate.domain === hostname);
  const domainSpecs = app.spec?.domains ?? [];
  const ingressRules = (app.spec?.ingress?.rules ?? []).filter((rule) => rule?.match?.authority?.exact === hostname);
  if (!domainSpec) {
    throw new Error(`App Platform spec does not contain domain '${hostname}'.`);
  }

  console.log(`Resetting stale App Platform domain attachment '${hostname}'.`);
  await command("doctl", ["apps", "update", appId, "--spec", "-", "--wait"], {
    input: JSON.stringify(removeDomainAttachment(app.spec, hostname)),
  });

  const latestAppResponse = await runJson("doctl", ["apps", "get", appId, "--output", "json"], options);
  const latestApp = normalizeAppResponse(latestAppResponse);
  await command("doctl", ["apps", "update", appId, "--spec", "-", "--wait"], {
    input: JSON.stringify(restoreDomainAttachment(latestApp.spec, domainSpecs, hostname, ingressRules)),
  });

  return true;
}

export async function captureRollbackTarget(appId, options = {}) {
  const runJson = options.commandJson ?? commandJson;
  const appResponse = await runJson("doctl", ["apps", "get", appId, "--output", "json"], options);
  const app = normalizeAppResponse(appResponse);
  return appRollbackTarget(app, { ...options, registryName: options.registryName });
}

export async function rollbackAppImage(appId, target, options = {}) {
  const runJson = options.commandJson ?? commandJson;
  const command = options.commandOutput ?? commandOutput;
  const appResponse = await runJson("doctl", ["apps", "get", appId, "--output", "json"], options);
  const app = normalizeAppResponse(appResponse);
  const nextSpec = rollbackSpecToImage(app?.spec ?? {}, target, options);

  await command("doctl", ["apps", "update", appId, "--spec", "-", "--wait"], {
    input: JSON.stringify(nextSpec),
  });

  return {
    appId,
    imageRef: imageReference({
      registryName: target.registryName,
      repository: target.repository,
      tag: target.tag,
      digest: target.digest,
    }),
  };
}

export async function deployApp(appId, options = {}) {
  const command = options.commandOutput ?? commandOutput;
  const createArgs = ["apps", "create-deployment", appId, "--wait", "--format", "ID", "--no-header"];

  if (options.forceRebuild) {
    createArgs.push("--force-rebuild");
  }

  const createOutput = await command("doctl", createArgs);
  const deploymentId = createOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  if (!deploymentId) {
    throw new Error("DigitalOcean deployment did not return an ID.");
  }

  const phase = (
    await command("doctl", ["apps", "get-deployment", appId, deploymentId, "--format", "Phase", "--no-header"])
  ).trim();

  if (phase !== "ACTIVE") {
    throw new Error(`DigitalOcean deployment ${deploymentId} finished with phase '${phase}' instead of ACTIVE.`);
  }

  return deploymentId;
}

async function main(argv) {
  const [command, ...args] = argv;

  if (command === "plan-app-changed") {
    const [tfplanPath] = args;
    if (!tfplanPath) {
      throw new Error("Usage: node ./scripts/digitalocean-app-deployment.mjs plan-app-changed <tfplan>");
    }

    console.log(String(await planAppChanged(tfplanPath)));
    return;
  }

  if (command === "assert-no-destructive-changes") {
    const [tfplanPath, ...options] = args;
    if (!tfplanPath) {
      throw new Error(
        "Usage: node ./scripts/digitalocean-app-deployment.mjs assert-no-destructive-changes <tfplan> [--allow-file=<path>]",
      );
    }

    const allowFilePath = options.find((option) => option.startsWith("--allow-file="))?.slice("--allow-file=".length);
    const destructiveChangeApproval =
      allowFilePath && existsSync(allowFilePath) ? readDestructiveChangeAllowFile(allowFilePath) : undefined;

    await assertTerraformPlanSafe(tfplanPath, { destructiveChangeApproval });
    return;
  }

  if (command === "summarize-plan") {
    const [tfplanJsonPath, ...options] = args;
    if (!tfplanJsonPath) {
      throw new Error(
        "Usage: node ./scripts/digitalocean-app-deployment.mjs summarize-plan <tfplan-json> [--title=<title>]",
      );
    }

    process.stdout.write(
      readTerraformPlanSummaryMarkdown(tfplanJsonPath, {
        title: readStringOption(options, "--title") ?? "Terraform plan",
      }),
    );
    return;
  }

  if (command === "postgres-cluster-id") {
    const [tfplanPath] = args;
    if (!tfplanPath) {
      throw new Error("Usage: node ./scripts/digitalocean-app-deployment.mjs postgres-cluster-id <tfplan>");
    }

    const clusterId = await readPostgresClusterIdFromPlan(tfplanPath);
    if (!clusterId) {
      throw new Error("Terraform plan did not expose digitalocean_database_cluster.postgres id.");
    }

    console.log(clusterId);
    return;
  }

  if (command === "wait") {
    const [appId, ...options] = args;
    if (!appId) {
      throw new Error("Usage: node ./scripts/digitalocean-app-deployment.mjs wait <app-id>");
    }

    await waitForDeployments(appId, {
      timeoutSeconds: readOption(options, "--timeout-seconds", 1800),
      pollSeconds: readOption(options, "--poll-seconds", 30),
    });
    return;
  }

  if (command === "diagnostics") {
    const [appId, ...options] = args;
    if (!appId) {
      throw new Error(
        "Usage: node ./scripts/digitalocean-app-deployment.mjs diagnostics <app-id> [--deployment=<deployment-id>] [--component=<name>] [--log-type=<type>] [--tail-lines=<lines>]",
      );
    }

    const outPath = readStringOption(options, "--out");
    const result = await collectDeploymentDiagnostics(appId, {
      deploymentId: readStringOption(options, "--deployment"),
      componentNames: readStringOptions(options, "--component"),
      logTypes: readStringOptions(options, "--log-type"),
      tailLines: readOption(options, "--tail-lines", 200),
      includeMetadata: Boolean(outPath),
    });
    if (outPath) {
      await writeJsonRecord(
        outPath,
        buildDeploymentDiagnosticsRecord({
          appId,
          deploymentId: result.deploymentId,
          deploymentPhase: result.deploymentPhase,
          componentNames: result.componentNames,
          logTypes: result.logTypes,
          steps: result.steps,
          logs: result.logs,
        }),
      );
    }
    return;
  }

  if (command === "deploy") {
    const [appId, ...options] = args;
    if (!appId) {
      throw new Error("Usage: node ./scripts/digitalocean-app-deployment.mjs deploy <app-id>");
    }

    await deployApp(appId, { forceRebuild: options.includes("--force-rebuild") });
    return;
  }

  if (command === "wait-domains") {
    const [appId, ...optionsAndHostnames] = args;
    if (!appId) {
      throw new Error("Usage: node ./scripts/digitalocean-app-deployment.mjs wait-domains <app-id> <hostname...>");
    }

    const hostnames = optionsAndHostnames.filter((arg) => !arg.startsWith("--"));
    await waitForDomains(appId, hostnames, {
      timeoutSeconds: readOption(optionsAndHostnames, "--timeout-seconds", 1800),
      pollSeconds: readOption(optionsAndHostnames, "--poll-seconds", 30),
    });
    return;
  }

  if (command === "reset-domain") {
    const [appId, hostname, ...options] = args;
    if (!appId || !hostname) {
      throw new Error("Usage: node ./scripts/digitalocean-app-deployment.mjs reset-domain <app-id> <hostname>");
    }

    await resetStaleDomainAttachment(appId, hostname, { force: options.includes("--force") });
    return;
  }

  if (command === "capture-rollback-target") {
    const [appId, ...options] = args;
    if (!appId) {
      throw new Error(
        "Usage: node ./scripts/digitalocean-app-deployment.mjs capture-rollback-target <app-id> --registry-name=<name> [--repository=<repository>] [--last-known-good-commit=<sha>] [--release-tag=<tag>] [--out=<path>] [--github-output=<path>]",
      );
    }

    const target = await captureRollbackTarget(appId, {
      registryName: readStringOption(options, "--registry-name"),
      repository: readStringOption(options, "--repository"),
      lastKnownGoodCommit: readStringOption(options, "--last-known-good-commit", ""),
      releaseTag: readStringOption(options, "--release-tag", ""),
    });
    const outPath = readStringOption(options, "--out");
    if (outPath) {
      const { writeJsonRecord } = await import("./lib/output-file.mjs");
      await writeJsonRecord(outPath, target);
    }

    writeGithubOutput(readStringOption(options, "--github-output"), {
      rollback_app_id: target.appId,
      rollback_image_ref: target.imageRef,
      rollback_image_digest: target.digest,
      rollback_image_tag: target.tag,
      rollback_repository: target.repository,
      rollback_components: target.componentNames.join(","),
      rollback_registry_name: target.registryName,
      rollback_target_commit: target.lastKnownGoodCommit,
      rollback_release_tag: target.releaseTag,
    });

    console.log(JSON.stringify(target, null, 2));
    return;
  }

  if (command === "rollback-image") {
    const [appId, ...options] = args;
    if (!appId) {
      throw new Error(
        "Usage: node ./scripts/digitalocean-app-deployment.mjs rollback-image <app-id> --registry-name=<name> --repository=<repository> [--digest=<sha256:...>|--tag=<tag>]",
      );
    }

    const result = await rollbackAppImage(
      appId,
      {
        registryName: readStringOption(options, "--registry-name"),
        repository: readStringOption(options, "--repository"),
        digest: readStringOption(options, "--digest", ""),
        tag: readStringOption(options, "--tag", ""),
      },
      { repository: readStringOption(options, "--repository") },
    );
    console.log(`Rolled back App Platform app ${result.appId} to ${result.imageRef}.`);
    return;
  }

  throw new Error(
    "Usage: node ./scripts/digitalocean-app-deployment.mjs <plan-app-changed|assert-no-destructive-changes|postgres-cluster-id|wait|diagnostics|deploy|wait-domains|reset-domain|capture-rollback-target|rollback-image>",
  );
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
