#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MANAGED_REGISTRY_AUTHORITY = "chase-sets";
export const MANAGED_REGISTRY_READINESS_VERSION = "managed-registry-readiness/v1";
export const defaultManagedRegistryReadinessTimeoutSeconds = 120;
const maximumManagedRegistryReadinessTimeoutSeconds = 300;

export function managedRegistryReadinessChecks({ namespace, timeoutSeconds }) {
  const boundedNamespace = required(namespace, "--namespace");
  const boundedTimeoutSeconds = parseTimeoutSeconds(timeoutSeconds);
  const timeout = `--timeout=${boundedTimeoutSeconds}s`;

  return [
    {
      diagnostic: `managed Secret '${MANAGED_REGISTRY_AUTHORITY}' exists in namespace '${boundedNamespace}'`,
      args: ["wait", "--for=create", `secret/${MANAGED_REGISTRY_AUTHORITY}`, "--namespace", boundedNamespace, timeout],
    },
    {
      diagnostic: `default ServiceAccount exists in namespace '${boundedNamespace}'`,
      args: ["wait", "--for=create", "serviceaccount/default", "--namespace", boundedNamespace, timeout],
    },
  ];
}

export function managedRegistryServiceAccountReferenceCheck({ namespace, timeoutSeconds }) {
  const boundedNamespace = required(namespace, "--namespace");
  const boundedTimeoutSeconds = parseTimeoutSeconds(timeoutSeconds);
  return {
    diagnostic: `default ServiceAccount references managed Secret '${MANAGED_REGISTRY_AUTHORITY}' in namespace '${boundedNamespace}'`,
    args: [
      "wait",
      `--for=jsonpath={.imagePullSecrets[?(@.name=="${MANAGED_REGISTRY_AUTHORITY}")].name}=${MANAGED_REGISTRY_AUTHORITY}`,
      "serviceaccount/default",
      "--namespace",
      boundedNamespace,
      `--timeout=${boundedTimeoutSeconds}s`,
    ],
  };
}

export async function waitForManagedRegistryAuthority(options) {
  const namespace = required(options.namespace, "--namespace");
  const timeoutSeconds = parseTimeoutSeconds(options.timeoutSeconds ?? defaultManagedRegistryReadinessTimeoutSeconds);
  const run = options.run ?? runKubectl;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutSeconds * 1_000;
  const initialChecks = managedRegistryReadinessChecks({ namespace, timeoutSeconds });
  const initialResults = await Promise.allSettled(
    initialChecks.map((check) => run({ command: options.kubectlPath ?? "kubectl", args: check.args })),
  );
  const initialFailures = initialResults.flatMap((result, index) =>
    result.status === "rejected" ? [initialChecks[index].diagnostic] : [],
  );
  if (initialFailures.length > 0) {
    throw new Error(
      `Managed registry authority did not reconcile before the ${timeoutSeconds}s deadline: ${initialFailures.join(
        "; ",
      )}. No generated credential fallback is permitted.`,
    );
  }

  const remainingSeconds = Math.floor((deadline - now()) / 1_000);
  if (remainingSeconds < 1) {
    throw new Error(
      `Managed registry authority did not reconcile before the ${timeoutSeconds}s deadline: default ServiceAccount reference was not checked. No generated credential fallback is permitted.`,
    );
  }

  const referenceCheck = managedRegistryServiceAccountReferenceCheck({
    namespace,
    timeoutSeconds: remainingSeconds,
  });
  try {
    await run({ command: options.kubectlPath ?? "kubectl", args: referenceCheck.args });
  } catch {
    throw new Error(
      `Managed registry authority did not reconcile before the ${timeoutSeconds}s deadline: ${referenceCheck.diagnostic}. No generated credential fallback is permitted.`,
    );
  }

  return {
    schemaVersion: MANAGED_REGISTRY_READINESS_VERSION,
    namespace,
    authority: MANAGED_REGISTRY_AUTHORITY,
    checks: [...initialChecks.map(({ diagnostic }) => diagnostic), referenceCheck.diagnostic],
  };
}

function runKubectl({ command, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} readiness probe exited ${code ?? "without a status"}.`));
    });
  });
}

function parseTimeoutSeconds(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximumManagedRegistryReadinessTimeoutSeconds) {
    throw new Error(
      `--timeout-seconds must be a whole number from 1 through ${maximumManagedRegistryReadinessTimeoutSeconds}.`,
    );
  }
  return parsed;
}

function required(value, name) {
  if (value == null || String(value).trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return String(value);
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? required(args[index + 1], name) : fallback;
}

async function main(args) {
  const namespace = option(args, "--namespace");
  const timeoutSeconds = option(args, "--timeout-seconds", String(defaultManagedRegistryReadinessTimeoutSeconds));
  const result = await waitForManagedRegistryAuthority({ namespace, timeoutSeconds });
  console.log(
    `Managed registry authority '${result.authority}' is ready in namespace '${result.namespace}' (${result.checks.length} named checks).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
