#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { buildPlatformHelmValues, platformHelmPreviewPostgresName } from "./render-platform-helm-values.mjs";

const defaultGeneratedBy = "node ./scripts/platform-kubernetes-secret.mjs";
const previewPostgresAdminUrlKey = "PLATFORM_PREVIEW_POSTGRES_ADMIN_URL";
const previewPostgresSuperuserPasswordKey = "PREVIEW_POSTGRES_SUPERUSER_PASSWORD";
const previewPostgresApplicationPasswordKey = "PREVIEW_POSTGRES_APPLICATION_PASSWORD";

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

export function buildManagedPostgresDatabaseEnv(options) {
  const environment = options.environment ?? "managed";
  const queryConnectionMode = options.queryConnectionMode ?? "direct";
  if (queryConnectionMode !== "direct" && queryConnectionMode !== "pooled") {
    throw new Error(`Unsupported ${environment} query connection mode '${queryConnectionMode}'.`);
  }

  const resources = Array.isArray(options.terraformState?.resources) ? options.terraformState.resources : [];
  const resource = (type, name) => resources.find((candidate) => candidate.type === type && candidate.name === name);
  const indexed = (item) =>
    new Map((item?.instances ?? []).map((instance) => [String(instance.index_key ?? ""), instance.attributes ?? {}]));
  const cluster = resource("digitalocean_database_cluster", "postgres");
  const databases = indexed(resource("digitalocean_database_db", "contexts"));
  const contextUsers = indexed(resource("digitalocean_database_user", "contexts"));
  const wakeUsers = indexed(resource("digitalocean_database_user", "wake_listeners"));
  const contextPools = indexed(resource("digitalocean_database_connection_pool", "contexts"));
  const clusterAttrs = cluster?.instances?.[0]?.attributes ?? {};

  if (!clusterAttrs.host || !clusterAttrs.port) {
    throw new Error(
      `${capitalize(environment)} Terraform state does not contain a usable DigitalOcean database cluster.`,
    );
  }

  const directUrlFor = (contextName, users) => {
    const database = databases.get(contextName);
    const user = users.get(contextName);
    if (!database?.name || !user?.name || !user?.password) {
      throw new Error(`${capitalize(environment)} Terraform state is missing database/user data for '${contextName}'.`);
    }
    return postgresManagedUrl({
      username: user.name,
      password: user.password,
      host: clusterAttrs.host,
      port: clusterAttrs.port,
      database: database.name,
    });
  };
  const pooledUrlFor = (contextName) => {
    const pool = contextPools.get(contextName);
    const contextUser = contextUsers.get(contextName);
    const username = pool?.user || contextUser?.name;
    const password = pool?.password || contextUser?.password;
    if (
      !pool?.name ||
      !pool?.host ||
      !pool?.port ||
      !username ||
      !password ||
      (pool.mode && pool.mode !== "transaction")
    ) {
      throw new Error(`${capitalize(environment)} Terraform state is missing a transaction pool for '${contextName}'.`);
    }
    return postgresManagedUrl({
      username,
      password,
      host: pool.host,
      port: pool.port,
      database: pool.name,
    });
  };
  const queryUrlFor = (contextName) =>
    queryConnectionMode === "pooled" ? pooledUrlFor(contextName) : directUrlFor(contextName, contextUsers);
  const result = {};

  for (const key of options.secretKeys ?? []) {
    let match = /^BOOTSTRAP_DATABASE_URL_([A-Z0-9_]+)$/.exec(key);
    if (match) {
      result[key] = directUrlFor(contextNameFromEnvToken(match[1]), contextUsers);
      continue;
    }

    if (key === "BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL") {
      result[key] = directUrlFor("control", contextUsers);
      continue;
    }

    match = /^DATABASE_URL_([A-Z0-9_]+)_WAITER$/.exec(key);
    if (match) {
      result[key] = directUrlFor(contextNameFromEnvToken(match[1]), wakeUsers);
      continue;
    }

    match = /^WORKER_LISTENER_DATABASE_URL_([A-Z0-9_]+)$/.exec(key);
    if (match) {
      result[key] = directUrlFor(contextNameFromEnvToken(match[1]), wakeUsers);
      continue;
    }

    match = /^DATABASE_URL_([A-Z0-9_]+)$/.exec(key);
    if (match) {
      result[key] = queryUrlFor(contextNameFromEnvToken(match[1]));
      continue;
    }

    if (key === "PLATFORM_CONTROL_DATABASE_URL") {
      result[key] = queryUrlFor("control");
      continue;
    }

    if (key === "PLATFORM_WORK_SIGNAL_DATABASE_URL") {
      result[key] = directUrlFor("control", contextUsers);
    }
  }

  return result;
}

export function exportManagedPostgresDatabaseEnv(options) {
  const databaseEnv = buildManagedPostgresDatabaseEnv(options);
  const githubEnvPath = options.githubEnvPath ?? process.env.GITHUB_ENV;
  if (!githubEnvPath) {
    throw new Error("GITHUB_ENV is required to export managed Postgres database URLs.");
  }

  const lines = Object.entries(databaseEnv).map(([name, value]) => {
    (options.log ?? console.log)(`::add-mask::${value}`);
    return `${name}=${value}`;
  });
  appendFileSync(githubEnvPath, `${lines.join("\n")}\n`);

  return { keyCount: lines.length, keys: Object.keys(databaseEnv) };
}

export function buildPlatformSecretManifest(options = {}) {
  return buildPlatformSecretBundle(options).runtimeSecret;
}

export function buildPlatformSecretBundle(options = {}) {
  const values = options.values ?? buildPlatformHelmValues({ repoRoot: options.repoRoot });
  const secretName = options.secretName ?? values.global?.existingSecretName;
  const namespace = options.namespace;
  const env = options.env ?? process.env;
  const secretKeys = options.secretKeys ?? collectPlatformSecretKeys(values);
  const previewPostgres = buildPreviewPostgresSecretMaterial({ ...options, values, env, secretKeys });
  const resolvedEnv = { ...env, ...(previewPostgres?.runtimeEnv ?? {}) };
  const missing = secretKeys.filter((key) => !Object.hasOwn(env, key));
  const requiredMissing = missing.filter((key) => !Object.hasOwn(previewPostgres?.runtimeEnv ?? {}, key));

  if (!secretName) {
    throw new Error("Platform Kubernetes secret name is required.");
  }

  if (requiredMissing.length > 0) {
    throw new Error(`Missing Kubernetes secret environment value(s): ${requiredMissing.join(", ")}.`);
  }

  const runtimeSecret = {
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
      secretKeys.map((key) => [key, Buffer.from(String(resolvedEnv[key] ?? ""), "utf8").toString("base64")]),
    ),
  };

  return {
    runtimeSecret,
    previewPostgresSecret: previewPostgres?.secret ?? null,
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
  const bundle =
    options.bundle ??
    (options.manifest
      ? { runtimeSecret: options.manifest, previewPostgresSecret: null }
      : buildPlatformSecretBundle(options));
  const manifest = bundle.runtimeSecret;
  const kubectlPath = options.kubectlPath ?? "kubectl";
  const namespace = manifest.metadata.namespace;
  const namespaceManifest = buildNamespaceManifest(namespace);

  if (namespaceManifest) {
    await applyManifest({ manifest: namespaceManifest, kubectlPath, spawn: options.spawn });
  }

  if (bundle.previewPostgresSecret) {
    await applyManifest({ manifest: bundle.previewPostgresSecret, kubectlPath, spawn: options.spawn });
  }

  await applyManifest({ manifest, kubectlPath, spawn: options.spawn });

  return {
    name: manifest.metadata.name,
    namespace: namespace ?? null,
    keyCount: Object.keys(manifest.data ?? {}).length,
    ...(bundle.previewPostgresSecret ? { previewPostgresSecretName: bundle.previewPostgresSecret.metadata.name } : {}),
  };
}

function buildPreviewPostgresSecretMaterial(options) {
  const environment = options.deploymentEnvironment ?? options.env.DEPLOYMENT_ENVIRONMENT;
  if (environment !== "preview") {
    return {
      secret: null,
      runtimeEnv: {
        [previewPostgresAdminUrlKey]: "",
      },
    };
  }

  const values = options.values;
  const previewPostgres = values.previewPostgres ?? {};
  const secretName = previewPostgres.secretName;
  const namespace = options.namespace;
  const serviceName =
    options.previewPostgresServiceName ??
    platformHelmPreviewPostgresName({ releaseName: options.release ?? options.env.CHASE_SETS_HELM_RELEASE });
  const port = previewPostgres.service?.port ?? 5432;
  const superuserPassword =
    options.env[previewPostgresSuperuserPasswordKey] ?? options.superuserPassword ?? generateSecretToken(options);
  const applicationPassword =
    options.env[previewPostgresApplicationPasswordKey] ?? options.applicationPassword ?? generateSecretToken(options);
  const runtimeEnv = {
    [previewPostgresAdminUrlKey]: postgresUrl({
      username: "postgres",
      password: superuserPassword,
      host: serviceName,
      port,
      database: "postgres",
    }),
  };

  for (const key of options.secretKeys) {
    if (Object.hasOwn(options.env, key)) {
      continue;
    }
    const contextName = contextNameForDatabaseSecretKey(key);
    if (!contextName) {
      continue;
    }

    runtimeEnv[key] = postgresUrl({
      username: previewDatabaseUser(contextName),
      password: applicationPassword,
      host: serviceName,
      port,
      database: previewDatabaseName(contextName),
    });
  }

  if (!secretName) {
    throw new Error("Preview Postgres secret name is required.");
  }

  return {
    runtimeEnv,
    secret: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: secretName,
        ...(namespace ? { namespace } : {}),
        labels: {
          "app.kubernetes.io/name": "chase-sets-platform",
          "app.kubernetes.io/component": "preview-postgres",
          "app.kubernetes.io/managed-by": "github-actions",
        },
        annotations: {
          "chase-sets.com/generated-by": defaultGeneratedBy,
        },
      },
      type: "Opaque",
      data: {
        [previewPostgres.superuserSecretKey ?? "POSTGRES_PASSWORD"]: Buffer.from(superuserPassword, "utf8").toString(
          "base64",
        ),
        [previewPostgres.applicationSecretKey ?? "APP_DATABASE_PASSWORD"]: Buffer.from(
          applicationPassword,
          "utf8",
        ).toString("base64"),
      },
    },
  };
}

function contextNameForDatabaseSecretKey(key) {
  if (key === "BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL") {
    return "control";
  }

  let match = /^BOOTSTRAP_DATABASE_URL_([A-Z0-9_]+)$/.exec(key);
  if (match) {
    return contextNameFromEnvToken(match[1]);
  }

  if (key === "PLATFORM_CONTROL_DATABASE_URL" || key === "PLATFORM_WORK_SIGNAL_DATABASE_URL") {
    return "control";
  }

  match = /^DATABASE_URL_([A-Z0-9_]+)_WAITER$/.exec(key);
  if (match) {
    return contextNameFromEnvToken(match[1]);
  }

  match = /^DATABASE_URL_([A-Z0-9_]+)$/.exec(key);
  if (match) {
    return contextNameFromEnvToken(match[1]);
  }

  match = /^WORKER_LISTENER_DATABASE_URL_([A-Z0-9_]+)$/.exec(key);
  if (match) {
    return contextNameFromEnvToken(match[1]);
  }

  return null;
}

function contextNameFromEnvToken(token) {
  return token.toLowerCase().replaceAll("_", "-");
}

function previewDatabaseName(contextName) {
  return `chase_sets_preview_${contextName.replaceAll("-", "_")}`;
}

function previewDatabaseUser(contextName) {
  return `cs_preview_${contextName.replaceAll("-", "_")}`;
}

function postgresUrl({ username, password, host, port, database }) {
  // The disposable in-cluster preview Postgres does not serve SSL, and the
  // shared pool factory force-upgrades URLs without an explicit sslmode to
  // verified SSL for non-local hosts. Preview URLs must therefore state
  // sslmode=disable; staging/production URLs are never synthesized here and
  // keep their managed-cluster sslmode=require shape.
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?sslmode=disable`;
}

function postgresManagedUrl({ username, password, host, port, database }) {
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?sslmode=require`;
}

function capitalize(value) {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function generateSecretToken(options) {
  const bytes = options.randomBytes?.(24) ?? randomBytes(24);
  return Buffer.from(bytes).toString("base64url");
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
  const previewPostgres = buildPreviewPostgresSecretMaterial({
    ...options,
    values,
    env: options.env ?? process.env,
    secretKeys,
  });
  return {
    name: options.secretName ?? values.global?.existingSecretName,
    namespace: options.namespace ?? null,
    keyCount: secretKeys.length,
    keys: secretKeys,
    ...(previewPostgres?.secret ? { previewPostgresSecretName: previewPostgres.secret.metadata.name } : {}),
  };
}

function parseArgs(argv, env = process.env) {
  const options = {
    namespace: env.CHASE_SETS_KUBERNETES_NAMESPACE,
    secretName: env.CHASE_SETS_PLATFORM_SECRET_NAME,
    release: env.CHASE_SETS_HELM_RELEASE,
    deploymentEnvironment: env.DEPLOYMENT_ENVIRONMENT,
    dryRun: false,
    exportDatabaseUrls: false,
    terraformStatePath: undefined,
    databaseEnvironment: env.DEPLOYMENT_ENVIRONMENT,
    queryConnectionMode: "direct",
    kubectlPath: env.KUBECTL_PATH ?? "kubectl",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--export-database-urls") {
      options.exportDatabaseUrls = true;
      options.terraformStatePath = readNextArg(argv, ++index, arg);
    } else if (arg === "--database-environment") {
      options.databaseEnvironment = readNextArg(argv, ++index, arg);
    } else if (arg === "--query-connection-mode") {
      options.queryConnectionMode = readNextArg(argv, ++index, arg);
    } else if (arg === "--namespace") {
      options.namespace = readNextArg(argv, ++index, arg);
    } else if (arg === "--secret-name") {
      options.secretName = readNextArg(argv, ++index, arg);
    } else if (arg === "--kubectl") {
      options.kubectlPath = readNextArg(argv, ++index, arg);
    } else {
      throw new Error(
        "Usage: node ./scripts/platform-kubernetes-secret.mjs [--dry-run] [--namespace <name>] [--secret-name <name>] [--kubectl <path>] [--export-database-urls <terraform-state-path> --database-environment <name> --query-connection-mode <direct|pooled>]",
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
  if (options.exportDatabaseUrls) {
    if (options.dryRun) {
      throw new Error("--dry-run and --export-database-urls cannot be combined.");
    }
    const secretSummary = summarizePlatformSecret(options);
    const result = exportManagedPostgresDatabaseEnv({
      terraformState: JSON.parse(readFileSync(options.terraformStatePath, "utf8")),
      secretKeys: secretSummary.keys,
      environment: options.databaseEnvironment,
      queryConnectionMode: options.queryConnectionMode,
      githubEnvPath: env.GITHUB_ENV,
    });
    console.log(
      `Exported ${result.keyCount} ${options.databaseEnvironment ?? "managed"} Kubernetes database URL values.`,
    );
    return 0;
  }
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
