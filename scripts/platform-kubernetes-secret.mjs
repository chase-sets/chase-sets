#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { buildPlatformHelmValues } from "./render-platform-helm-values.mjs";

const defaultGeneratedBy = "node ./scripts/platform-kubernetes-secret.mjs";

export function collectPlatformSecretKeys(values = buildPlatformHelmValues()) {
  const keys = new Set();

  for (const component of Object.values(values.components ?? {})) {
    for (const entry of component.env ?? []) {
      if (entry.secret) {
        keys.add(entry.secretKey ?? entry.name);
      }
    }
  }

  return [...keys].sort((left, right) => left.localeCompare(right, "en"));
}

export function buildPlatformSecretManifest(options = {}) {
  const values = options.values ?? buildPlatformHelmValues({ repoRoot: options.repoRoot });
  const secretName = options.secretName ?? values.global?.existingSecretName;
  const namespace = options.namespace;
  const env = options.env ?? process.env;
  const secretKeys = options.secretKeys ?? collectPlatformSecretKeys(values);
  const missing = secretKeys.filter((key) => !Object.hasOwn(env, key));

  if (!secretName) {
    throw new Error("Platform Kubernetes secret name is required.");
  }

  if (missing.length > 0) {
    throw new Error(`Missing Kubernetes secret environment value(s): ${missing.join(", ")}.`);
  }

  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName,
      ...(namespace ? { namespace } : {}),
      labels: {
        "app.kubernetes.io/name": "chase-sets-platform",
        "app.kubernetes.io/component": "runtime-secrets",
        "app.kubernetes.io/managed-by": "github-actions",
      },
      annotations: {
        "chase-sets.com/generated-by": defaultGeneratedBy,
      },
    },
    type: "Opaque",
    data: Object.fromEntries(
      secretKeys.map((key) => [key, Buffer.from(String(env[key] ?? ""), "utf8").toString("base64")]),
    ),
  };
}

export function buildNamespaceManifest(namespace) {
  if (!namespace) {
    return null;
  }

  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/name": "chase-sets-platform",
        "app.kubernetes.io/managed-by": "github-actions",
      },
      annotations: {
        "chase-sets.com/generated-by": defaultGeneratedBy,
      },
    },
  };
}

export async function applyPlatformSecretManifest(options = {}) {
  const manifest = options.manifest ?? buildPlatformSecretManifest(options);
  const kubectlPath = options.kubectlPath ?? "kubectl";
  const namespace = manifest.metadata.namespace;
  const namespaceManifest = buildNamespaceManifest(namespace);

  if (namespaceManifest) {
    await applyManifest({ manifest: namespaceManifest, kubectlPath, spawn: options.spawn });
  }

  await applyManifest({ manifest, kubectlPath, spawn: options.spawn });

  return {
    name: manifest.metadata.name,
    namespace: namespace ?? null,
    keyCount: Object.keys(manifest.data ?? {}).length,
  };
}

async function applyManifest(options) {
  const spawnImpl = options.spawn ?? spawn;
  const input = `${JSON.stringify(options.manifest)}\n`;
  const kubectlPath = options.kubectlPath;

  await new Promise((resolve, reject) => {
    const child = spawnImpl(kubectlPath, ["apply", "-f", "-"], {
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${kubectlPath} apply -f - exited with code ${code ?? "unknown"}.`));
    });
    child.stdin.end(input);
  });
}

export function summarizePlatformSecret(options = {}) {
  const values = options.values ?? buildPlatformHelmValues({ repoRoot: options.repoRoot });
  const secretKeys = options.secretKeys ?? collectPlatformSecretKeys(values);
  return {
    name: options.secretName ?? values.global?.existingSecretName,
    namespace: options.namespace ?? null,
    keyCount: secretKeys.length,
    keys: secretKeys,
  };
}

function parseArgs(argv, env = process.env) {
  const options = {
    namespace: env.CHASE_SETS_KUBERNETES_NAMESPACE,
    secretName: env.CHASE_SETS_PLATFORM_SECRET_NAME,
    dryRun: false,
    kubectlPath: env.KUBECTL_PATH ?? "kubectl",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--namespace") {
      options.namespace = readNextArg(argv, ++index, arg);
    } else if (arg === "--secret-name") {
      options.secretName = readNextArg(argv, ++index, arg);
    } else if (arg === "--kubectl") {
      options.kubectlPath = readNextArg(argv, ++index, arg);
    } else {
      throw new Error(
        "Usage: node ./scripts/platform-kubernetes-secret.mjs [--dry-run] [--namespace <name>] [--secret-name <name>] [--kubectl <path>]",
      );
    }
  }

  return options;
}

function readNextArg(argv, index, name) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function main(argv, env = process.env) {
  const options = parseArgs(argv, env);
  if (options.dryRun) {
    console.log(JSON.stringify(summarizePlatformSecret(options), null, 2));
    return 0;
  }

  const result = await applyPlatformSecretManifest({ ...options, env });
  console.log(
    `Applied Kubernetes Secret ${result.namespace ? `${result.namespace}/` : ""}${result.name} with ${result.keyCount} keys.`,
  );
  return 0;
}

if (process.argv[1]?.endsWith("platform-kubernetes-secret.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
