import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const TERMINAL_DEPLOYMENT_PHASES = new Set(["ACTIVE", "ERROR", "CANCELED", "CANCELLED", "SUPERSEDED"]);

const ACTIVE_DOMAIN_PHASE = "ACTIVE";
const DEFAULT_DEPLOYMENT_LOG_TYPES = ["deploy", "run", "run_restarted"];
const DIGITALOCEAN_API_BASE_URL = "https://api.digitalocean.com/v2";
const DEPLOYMENT_SUMMARY_API_PAGE_SIZE = 20;
const DEPLOYMENT_SUMMARY_FIELDS = "ID,Phase,Updated";
const MAX_DIAGNOSTIC_ERROR_MESSAGE_LENGTH = 2_000;

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
    execFile(command, args, { maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr.trim() || stdout.trim() || error.message;
        reject(
          createCommandError(command, args, message, { exitCode: error.code, signal: error.signal, stdout, stderr }),
        );
        return;
      }

      resolve(stdout);
    });
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

export function approvedDestructiveChangeAddressesFromText(text) {
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

  return [...new Set(addresses)];
}

export function readDestructiveChangeAllowFile(filePath) {
  return approvedDestructiveChangeAddressesFromText(readFileSync(filePath, "utf8"));
}

export function assertNoDestructiveChanges(plan, options = {}) {
  const destructiveChanges = destructiveResourceChanges(plan);
  if (destructiveChanges.length === 0) {
    return destructiveChanges;
  }

  if (options.allowedDestructiveAddresses?.length > 0) {
    const allowed = new Set(options.allowedDestructiveAddresses);
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

export async function assertTerraformPlanSafe(tfplanPath, options = {}) {
  const output = await (options.commandOutput ?? commandOutput)("terraform", ["show", "-json", tfplanPath]);
  return assertNoDestructiveChanges(JSON.parse(output), options);
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

  try {
    const deploymentDetails = normalizeDeploymentResponse(
      await runJson("doctl", ["apps", "get-deployment", appId, deployment.id, "--output", "json"], jsonOptions),
    );
    const steps = deploymentProgressSteps(deploymentDetails);

    if (steps.length > 0) {
      log("Deployment progress:");
      for (const step of steps) {
        const name = step.name ?? step.Name ?? step.component_name ?? step.componentName ?? "unnamed-step";
        const status = step.status ?? step.Status ?? step.phase ?? step.Phase ?? "unknown";
        const reason = step.reason?.message ?? step.reason?.code ?? step.Reason?.Message ?? step.Reason?.Code ?? "";
        log(`- ${name}: ${status}${reason ? ` - ${reason}` : ""}`);
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
        const output = await command("doctl", args);
        const trimmed = output.trim();
        log(trimmed || "(no log lines returned)");
        collectedLogs.push({ componentName, logType, ok: true, output });
      } catch (error) {
        const message = diagnosticErrorMessage(error);
        warn(`Unable to load ${componentName} ${logType} logs: ${message}`);
        collectedLogs.push({ componentName, logType, ok: false, error: message });
      }
    }
  }

  return { deploymentId: deployment.id, logs: collectedLogs };
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
    const allowedDestructiveAddresses =
      allowFilePath && existsSync(allowFilePath) ? readDestructiveChangeAllowFile(allowFilePath) : [];

    await assertTerraformPlanSafe(tfplanPath, { allowedDestructiveAddresses });
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

    await collectDeploymentDiagnostics(appId, {
      deploymentId: readStringOption(options, "--deployment"),
      componentNames: readStringOptions(options, "--component"),
      logTypes: readStringOptions(options, "--log-type"),
      tailLines: readOption(options, "--tail-lines", 200),
    });
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

  throw new Error(
    "Usage: node ./scripts/digitalocean-app-deployment.mjs <plan-app-changed|assert-no-destructive-changes|wait|diagnostics|deploy|wait-domains|reset-domain>",
  );
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
