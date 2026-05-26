import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const TERMINAL_DEPLOYMENT_PHASES = new Set(["ACTIVE", "ERROR", "CANCELED", "CANCELLED", "SUPERSEDED"]);

const ACTIVE_DOMAIN_PHASE = "ACTIVE";

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
          reject(new Error(`${command} ${args.join(" ")} failed: ${message}`));
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
        reject(new Error(`${command} ${args.join(" ")} failed: ${message}`));
        return;
      }

      resolve(stdout);
    });
  });
}

async function commandJson(command, args, options = {}) {
  const output = await (options.commandOutput ?? commandOutput)(command, args);
  return JSON.parse(output);
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

function normalizeDeployment(deployment) {
  return {
    id: deployment.id ?? deployment.ID ?? "",
    phase: deployment.phase ?? deployment.Phase ?? "",
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

export function assertNoDestructiveChanges(plan, options = {}) {
  const destructiveChanges = destructiveResourceChanges(plan);
  if (destructiveChanges.length === 0) {
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
  const runJson = options.commandJson ?? commandJson;
  const deadline = now() + timeoutSeconds * 1000;

  while (true) {
    let deploymentResponse;
    try {
      deploymentResponse = await runJson("doctl", ["apps", "list-deployments", appId, "--output", "json"], options);
    } catch (error) {
      if (appNotFound(error)) {
        console.log(`App Platform app '${appId}' no longer exists; skipping deployment wait.`);
        return;
      }
      throw error;
    }

    const deployments = activeDeployments(deploymentResponse);

    if (deployments.length === 0) {
      console.log("No in-progress App Platform deployments remain.");
      return;
    }

    if (now() >= deadline) {
      const summary = deployments.map((deployment) => `- ${deployment.id}: ${deployment.phase}`).join("\n");
      throw new Error(`Timed out waiting for App Platform deployments to finish:\n${summary}`);
    }

    console.log("Waiting for App Platform deployment capacity:");
    for (const deployment of deployments) {
      console.log(`- ${deployment.id}: ${deployment.phase}`);
    }

    await delay(pollSeconds * 1000);
  }
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
    const allowDestructiveChanges = Boolean(allowFilePath && existsSync(allowFilePath));

    await assertTerraformPlanSafe(tfplanPath, { allowDestructiveChanges });
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
    "Usage: node ./scripts/digitalocean-app-deployment.mjs <plan-app-changed|assert-no-destructive-changes|wait|deploy|wait-domains|reset-domain>",
  );
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
