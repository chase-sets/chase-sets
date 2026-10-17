#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";

const stripeKeyCase = (family, prefix, mode, keyClass) => Object.freeze({ family, prefix, mode, keyClass });

export const STRIPE_KEY_CASES = Object.freeze([
  stripeKeyCase("server", "", "absent", "absent"),
  stripeKeyCase("server", "sk_test_", "test", "standard"),
  stripeKeyCase("server", "sk_live_", "live", "standard"),
  stripeKeyCase("server", "rk_test_", "test", "restricted"),
  stripeKeyCase("server", "rk_live_", "live", "restricted"),
  stripeKeyCase("server", "", "unknown", "unknown"),
  stripeKeyCase("publishable", "", "absent", "absent"),
  stripeKeyCase("publishable", "pk_test_", "test", "standard"),
  stripeKeyCase("publishable", "pk_live_", "live", "standard"),
  stripeKeyCase("publishable", "", "unknown", "unknown"),
]);

const casesByFamily = Object.freeze({
  server: Object.freeze(STRIPE_KEY_CASES.filter((entry) => entry.family === "server")),
  publishable: Object.freeze(STRIPE_KEY_CASES.filter((entry) => entry.family === "publishable")),
});

function selectCase(value, family) {
  const familyCases = casesByFamily[family];
  const absent = familyCases.find((entry) => entry.mode === "absent");
  const unknown = familyCases.find((entry) => entry.mode === "unknown");
  if (value === null || value === undefined || value === "") {
    return absent;
  }
  if (typeof value !== "string") {
    return unknown;
  }
  return familyCases.find((entry) => entry.prefix !== "" && value.startsWith(entry.prefix)) ?? unknown;
}

export function classifyStripeKeys(secretKey, publishableKey) {
  const server = selectCase(secretKey, "server");
  const publishable = selectCase(publishableKey, "publishable");
  return Object.freeze({
    serverKeyMode: server.mode,
    serverKeyClass: server.keyClass,
    publishableKeyMode: publishable.mode,
  });
}

export function isUnrestrictedStripeSecretKeyForMode(value, expectedMode) {
  const classification = classifyStripeKeys(value, null);
  return classification.serverKeyMode === expectedMode && classification.serverKeyClass === "standard";
}

export function isStripePublishableKeyForMode(value, expectedMode) {
  return classifyStripeKeys(null, value).publishableKeyMode === expectedMode;
}

export function isUnrestrictedStripeKeyPair(secretKey, publishableKey, expectedMode) {
  const classification = classifyStripeKeys(secretKey, publishableKey);
  return (
    classification.serverKeyMode === expectedMode &&
    classification.serverKeyClass === "standard" &&
    classification.publishableKeyMode === expectedMode
  );
}

export function isStripeTestServerKey(value, { allowRestricted = false } = {}) {
  const classification = classifyStripeKeys(value, null);
  return (
    classification.serverKeyMode === "test" &&
    (classification.serverKeyClass === "standard" ||
      (allowRestricted && classification.serverKeyClass === "restricted"))
  );
}

export function evaluateUnrestrictedStripeKeyPair(secretKey, publishableKey, expectedMode) {
  const classification = classifyStripeKeys(secretKey, publishableKey);
  const reason =
    classification.serverKeyClass === "restricted"
      ? "restricted-server-key"
      : classification.serverKeyMode !== expectedMode || classification.serverKeyClass !== "standard"
        ? "server-key-mode"
        : classification.publishableKeyMode !== expectedMode
          ? "publishable-key-mode"
          : null;
  return Object.freeze({ admitted: reason === null, reason, classification });
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : (argv[index + 1] ?? null);
}

function boundedCliResult(result, secretVariable, publishableVariable) {
  return {
    admitted: result.admitted,
    reason: result.reason,
    expectedMode: result.expectedMode,
    variables: { secret: secretVariable, publishable: publishableVariable },
    classification: result.classification,
  };
}

export function runStripeKeyModeCli(argv, env = process.env, io = process) {
  const [command] = argv;
  if (command !== "require-unrestricted-pair") {
    io.stderr.write("stripe-key-mode requires the require-unrestricted-pair command.\n");
    return 2;
  }

  const expectedMode = readOption(argv, "--mode");
  const secretVariable = readOption(argv, "--secret-var");
  const publishableVariable = readOption(argv, "--publishable-var");
  if ((expectedMode !== "test" && expectedMode !== "live") || !secretVariable || !publishableVariable) {
    io.stderr.write("stripe-key-mode requires --mode test|live, --secret-var NAME, and --publishable-var NAME.\n");
    return 2;
  }

  const evaluated = evaluateUnrestrictedStripeKeyPair(env[secretVariable], env[publishableVariable], expectedMode);
  if (evaluated.admitted) {
    return 0;
  }

  io.stderr.write(
    `${JSON.stringify(boundedCliResult({ ...evaluated, expectedMode }, secretVariable, publishableVariable))}\n`,
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runStripeKeyModeCli(process.argv.slice(2));
}
