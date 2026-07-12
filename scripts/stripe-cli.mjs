import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "./lib/env.mjs";
import { applySandboxEnv, ensureWorktreeSandboxEnvironment, mergeSandboxEnvFile } from "./lib/sandbox.mjs";
import { PAYMENTS_PROVIDER_WEBHOOK_PATH, SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH } from "./provider-webhook-paths.mjs";
import webhookEventRegistry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const { env: sandboxEnv } = ensureWorktreeSandboxEnvironment({ rootDir });
applySandboxEnv(sandboxEnv);
const platformApiEnvExamplePath = path.join(rootDir, "deployables", "platform-api", ".env.example");
const platformApiEnvLocalPath = path.join(rootDir, "deployables", "platform-api", ".env.local");
const dockerImage = process.env.STRIPE_CLI_DOCKER_IMAGE ?? "stripe/stripe-cli";
const defaultForwardUrl = sandboxEnv.STRIPE_WEBHOOK_FORWARD_URL;
const defaultConnectForwardUrl =
  sandboxEnv.STRIPE_CONNECT_WEBHOOK_FORWARD_URL ??
  defaultForwardUrl?.replace(PAYMENTS_PROVIDER_WEBHOOK_PATH, SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH);
const readyFilePath = process.env.STRIPE_READY_FILE ?? null;
const connectAccountsApi = (process.env.STRIPE_CONNECT_ACCOUNTS_API ?? sandboxEnv.STRIPE_CONNECT_ACCOUNTS_API ?? "v2")
  .trim()
  .toLowerCase();
if (connectAccountsApi !== "v1" && connectAccountsApi !== "v2") {
  throw new Error("STRIPE_CONNECT_ACCOUNTS_API must be one of: v1, v2.");
}
const supportedWebhookEvents = [
  ...webhookEventRegistry.payment,
  ...webhookEventRegistry.connectAccounts[connectAccountsApi],
  ...webhookEventRegistry.connectMoneyMovement,
];

function printUsage() {
  console.log("Usage:");
  console.log("  node ./scripts/stripe-cli.mjs listen");
  console.log("");
  console.log("Environment:");
  console.log("  STRIPE_API_KEY                Overrides STRIPE_SECRET_KEY from deployables/platform-api/.env.local.");
  console.log("  STRIPE_WEBHOOK_FORWARD_URL    Overrides the sandbox webhook endpoint.");
  console.log("  STRIPE_CONNECT_WEBHOOK_FORWARD_URL Overrides the sandbox Connect webhook endpoint.");
  console.log("  STRIPE_CLI_DOCKER_IMAGE       Overrides the Stripe CLI Docker image name.");
}

function resolveStripeApiKey() {
  const envLocal = readEnvFile(platformApiEnvLocalPath);
  const envExample = readEnvFile(platformApiEnvExamplePath);

  return process.env.STRIPE_API_KEY ?? envLocal.STRIPE_SECRET_KEY ?? envExample.STRIPE_SECRET_KEY ?? null;
}

function persistWebhookSecret(webhookSecret) {
  const { sandbox } = mergeSandboxEnvFile(
    { STRIPE_WEBHOOK_SECRET: webhookSecret, STRIPE_CONNECT_WEBHOOK_SECRET: webhookSecret },
    { rootDir },
  );
  console.log(
    `[stripe] Saved STRIPE_WEBHOOK_SECRET and STRIPE_CONNECT_WEBHOOK_SECRET to ${path.relative(
      rootDir,
      sandbox.envFilePath,
    )}`,
  );
  console.log("[stripe] Restart platform-api if it was already running.");
}

function signalReady(webhookSecret) {
  if (!readyFilePath) {
    return;
  }

  writeFileSync(readyFilePath, `${webhookSecret}\n`, "utf8");
  console.log("[stripe] Listener is ready for platform-api startup.");
}

function pipeOutput(stream, target, onChunk) {
  stream.on("data", (chunk) => {
    const text = chunk.toString();
    target.write(text);
    onChunk(text);
  });
}

function buildDockerRunArgs(stripeApiKey, stripeArgs) {
  const dockerArgs = ["run", "--rm", "-i"];

  if (process.platform === "linux") {
    dockerArgs.push("--add-host", "host.docker.internal:host-gateway");
  }

  dockerArgs.push("-e", `STRIPE_API_KEY=${stripeApiKey}`);
  dockerArgs.push(dockerImage, ...stripeArgs);

  return dockerArgs;
}

async function runListen() {
  const stripeApiKey = resolveStripeApiKey();

  if (!stripeApiKey) {
    throw new Error(
      "Stripe API key not found. Set STRIPE_SECRET_KEY in deployables/platform-api/.env.local or export STRIPE_API_KEY before running stripe:listen.",
    );
  }

  const forwardTo = process.env.STRIPE_WEBHOOK_FORWARD_URL ?? defaultForwardUrl;
  const forwardConnectTo = process.env.STRIPE_CONNECT_WEBHOOK_FORWARD_URL ?? defaultConnectForwardUrl;
  const dockerArgs = buildDockerRunArgs(stripeApiKey, [
    "listen",
    "--forward-to",
    forwardTo,
    "--forward-connect-to",
    forwardConnectTo,
    "--events",
    supportedWebhookEvents.join(","),
  ]);

  console.log(`[stripe] Forwarding Stripe webhooks to ${forwardTo}`);
  console.log(`[stripe] Forwarding Stripe Connect webhooks to ${forwardConnectTo}`);
  console.log(`[stripe] Using Docker image ${dockerImage}`);

  await new Promise((resolve, reject) => {
    let resolved = false;
    let discoveredWebhookSecret = null;

    const child = spawn("docker", dockerArgs, {
      cwd: rootDir,
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
      },
      windowsHide: true,
    });

    const handleChunk = (text) => {
      const secretMatch = text.match(/whsec_[A-Za-z0-9]+/);

      if (secretMatch && discoveredWebhookSecret !== secretMatch[0]) {
        discoveredWebhookSecret = secretMatch[0];
        persistWebhookSecret(discoveredWebhookSecret);
        signalReady(discoveredWebhookSecret);
      }
    };

    child.on("error", reject);
    pipeOutput(child.stdout, process.stdout, handleChunk);
    pipeOutput(child.stderr, process.stderr, handleChunk);

    child.on("exit", (code) => {
      if (resolved) {
        return;
      }

      resolved = true;

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Stripe CLI Docker listener exited with code ${code ?? "unknown"}.`));
    });
  });
}

const command = process.argv[2] ?? "help";

try {
  if (command === "listen") {
    await runListen();
  } else {
    printUsage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
