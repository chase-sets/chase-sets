import { execFile } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const TERMINAL_DEPLOYMENT_PHASES = new Set([
  "ACTIVE",
  "ERROR",
  "CANCELED",
  "CANCELLED",
  "SUPERSEDED",
]);

const ACTIVE_DOMAIN_PHASE = "ACTIVE";

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { maxBuffer: 50 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || stdout.trim() || error.message;
          reject(new Error(`${command} ${args.join(" ")} failed: ${message}`));
          return;
        }

        resolve(stdout);
      },
    );
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

export function activeDeployments(deployments) {
  return deployments
    .map(normalizeDeployment)
    .filter((deployment) => !TERMINAL_DEPLOYMENT_PHASES.has(deployment.phase));
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
  return (
    /(?:not found|404|does not exist|could not find)/i.test(message) &&
    /\bapp(?:s| platform)?\b/i.test(message)
  );
}

export async function planAppChanged(tfplanPath, options = {}) {
  const output = await (options.commandOutput ?? commandOutput)("terraform", [
    "show",
    "-json",
    tfplanPath,
  ]);
  return appPlatformChanges(JSON.parse(output));
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
      deploymentResponse = await runJson(
        "doctl",
        ["apps", "list-deployments", appId, "--output", "json"],
        options,
      );
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
      const summary = deployments
        .map((deployment) => `- ${deployment.id}: ${deployment.phase}`)
        .join("\n");
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
      const summary = waiting
        .map((domain) => `- ${domain.name}: ${domain.phase}`)
        .join("\n");
      throw new Error(`Timed out waiting for App Platform domains to become active:\n${summary}`);
    }

    console.log("Waiting for App Platform domains to become active:");
    for (const domain of waiting) {
      console.log(`- ${domain.name}: ${domain.phase}`);
    }

    await delay(pollSeconds * 1000);
  }
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
    await command("doctl", [
      "apps",
      "get-deployment",
      appId,
      deploymentId,
      "--format",
      "Phase",
      "--no-header",
    ])
  ).trim();

  if (phase !== "ACTIVE") {
    throw new Error(
      `DigitalOcean deployment ${deploymentId} finished with phase '${phase}' instead of ACTIVE.`,
    );
  }

  return deploymentId;
}

async function main(argv) {
  const [command, ...args] = argv;

  if (command === "plan-app-changed") {
    const [tfplanPath] = args;
    if (!tfplanPath) {
      throw new Error(
        "Usage: node ./scripts/digitalocean-app-deployment.mjs plan-app-changed <tfplan>",
      );
    }

    console.log(String(await planAppChanged(tfplanPath)));
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
      throw new Error(
        "Usage: node ./scripts/digitalocean-app-deployment.mjs wait-domains <app-id> <hostname...>",
      );
    }

    const hostnames = optionsAndHostnames.filter((arg) => !arg.startsWith("--"));
    await waitForDomains(appId, hostnames, {
      timeoutSeconds: readOption(optionsAndHostnames, "--timeout-seconds", 1800),
      pollSeconds: readOption(optionsAndHostnames, "--poll-seconds", 30),
    });
    return;
  }

  throw new Error(
    "Usage: node ./scripts/digitalocean-app-deployment.mjs <plan-app-changed|wait|deploy|wait-domains>",
  );
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
