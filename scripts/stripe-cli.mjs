import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const marketplaceApiEnvExamplePath = path.join(
  rootDir,
  "deployables",
  "marketplace-api",
  ".env.example",
);
const marketplaceApiEnvLocalPath = path.join(
  rootDir,
  "deployables",
  "marketplace-api",
  ".env.local",
);
const dockerImage = process.env.STRIPE_CLI_DOCKER_IMAGE ?? "stripe/stripe-cli";
const defaultForwardUrl = "http://host.docker.internal:6182/api/payments/stripe/webhooks";
const readyFilePath = process.env.STRIPE_READY_FILE ?? null;
const supportedWebhookEvents = [
  "payment_intent.processing",
  "payment_intent.amount_capturable_updated",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
];

function printUsage() {
  console.log("Usage:");
  console.log("  node ./scripts/stripe-cli.mjs listen");
  console.log("");
  console.log("Environment:");
  console.log(
    "  STRIPE_API_KEY                Overrides STRIPE_SECRET_KEY from deployables/marketplace-api/.env.local.",
  );
  console.log(
    "  STRIPE_WEBHOOK_FORWARD_URL    Overrides the local webhook endpoint.",
  );
  console.log(
    "  STRIPE_CLI_DOCKER_IMAGE       Overrides the Stripe CLI Docker image name.",
  );
}

function parseEnvFile(content) {
  const values = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    values[key] = value;
  }

  return values;
}

function readEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  return parseEnvFile(readFileSync(filePath, "utf8"));
}

function resolveStripeApiKey() {
  const envLocal = readEnvFile(marketplaceApiEnvLocalPath);
  const envExample = readEnvFile(marketplaceApiEnvExamplePath);

  return (
    process.env.STRIPE_API_KEY ??
    envLocal.STRIPE_SECRET_KEY ??
    envExample.STRIPE_SECRET_KEY ??
    null
  );
}

function detectLineEnding(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function persistWebhookSecret(webhookSecret) {
  const envLocalExists = existsSync(marketplaceApiEnvLocalPath);
  const currentContent = envLocalExists
    ? readFileSync(marketplaceApiEnvLocalPath, "utf8")
    : "";
  const lineEnding = detectLineEnding(currentContent);
  const lines = currentContent.length > 0 ? currentContent.split(/\r?\n/) : [];
  let updated = false;

  const nextLines = lines.map((line) => {
    if (!line.startsWith("STRIPE_WEBHOOK_SECRET=")) {
      return line;
    }

    updated = true;
    return `STRIPE_WEBHOOK_SECRET=${webhookSecret}`;
  });

  if (!updated) {
    nextLines.push(`STRIPE_WEBHOOK_SECRET=${webhookSecret}`);
  }

  const nextContent = `${nextLines.join(lineEnding).replace(/[ \t]+$/gm, "")}${lineEnding}`;

  if (nextContent !== currentContent) {
    writeFileSync(marketplaceApiEnvLocalPath, nextContent, "utf8");
    console.log(
      `[stripe] Saved STRIPE_WEBHOOK_SECRET to ${path.relative(rootDir, marketplaceApiEnvLocalPath)}`,
    );
    console.log("[stripe] Restart marketplace-api if it was already running.");
  }
}

function signalReady(webhookSecret) {
  if (!readyFilePath) {
    return;
  }

  writeFileSync(readyFilePath, `${webhookSecret}\n`, "utf8");
  console.log("[stripe] Listener is ready for marketplace-api startup.");
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
      "Stripe API key not found. Set STRIPE_SECRET_KEY in deployables/marketplace-api/.env.local or export STRIPE_API_KEY before running stripe:listen.",
    );
  }

  const forwardTo = process.env.STRIPE_WEBHOOK_FORWARD_URL ?? defaultForwardUrl;
  const dockerArgs = buildDockerRunArgs(stripeApiKey, [
    "listen",
    "--forward-to",
    forwardTo,
    "--events",
    supportedWebhookEvents.join(","),
  ]);

  console.log(`[stripe] Forwarding Stripe webhooks to ${forwardTo}`);
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

      reject(
        new Error(
          `Stripe CLI Docker listener exited with code ${code ?? "unknown"}.`,
        ),
      );
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
