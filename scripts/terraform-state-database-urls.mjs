#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFile, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { safeFailureFields } from "./lib/postgres-connection.mjs";
import { applyManagedPostgresCaSecret } from "./platform-kubernetes-secret.mjs";

const DIGITALOCEAN_API_BASE_URL = "https://api.digitalocean.com/v2";
const DIGITALOCEAN_CA_RESPONSE_MAX_BYTES = 65_536;
const DEFAULT_CA_RETRY_ATTEMPTS = 1;
const DEFAULT_CA_RETRY_BACKOFF_MS = 0;
const MAX_CA_RETRY_ATTEMPTS = 5;
const MAX_CA_RETRY_BACKOFF_MS = 30_000;

export function parseTerraformStateDatabaseUrlArgs(argv, env = process.env) {
  const contextsOption = readOption(argv, "--contexts");
  const connectionModeOption = readOption(argv, "--connection-mode");
  const selectionModeOption = readOption(argv, "--selection-mode");
  return {
    mode: readOption(argv, "--mode") ?? "url-export",
    statePath: readOption(argv, "--state") ?? readEnv("TERRAFORM_STATE_PATH", env),
    githubEnvPath: readOption(argv, "--github-env") ?? readEnv("GITHUB_ENV", env),
    caPath:
      readOption(argv, "--ca-path") ??
      readEnv("MANAGED_POSTGRES_CA_PATH", env) ??
      (readEnv("RUNNER_TEMP", env)
        ? join(readEnv("RUNNER_TEMP", env), "digitalocean-managed-postgres-ca.pem")
        : undefined),
    digitalOceanToken: readEnv("DIGITALOCEAN_ACCESS_TOKEN", env),
    environmentName: readOption(argv, "--environment") ?? readEnv("DEPLOYMENT_ENVIRONMENT", env) ?? "staging",
    contexts: parseContexts(contextsOption ?? readEnv("TERRAFORM_STATE_DATABASE_URL_CONTEXTS", env)),
    contextsSpecified: contextsOption != null || readEnv("TERRAFORM_STATE_DATABASE_URL_CONTEXTS", env) != null,
    connectionMode: connectionModeOption ?? readEnv("TERRAFORM_STATE_DATABASE_URL_CONNECTION_MODE", env) ?? "direct",
    connectionModeSpecified:
      connectionModeOption != null || readEnv("TERRAFORM_STATE_DATABASE_URL_CONNECTION_MODE", env) != null,
    selectionMode: selectionModeOption ?? readEnv("TERRAFORM_STATE_DATABASE_URL_SELECTION_MODE", env) ?? "all",
    selectionModeSpecified:
      selectionModeOption != null || readEnv("TERRAFORM_STATE_DATABASE_URL_SELECTION_MODE", env) != null,
    namespace: readOption(argv, "--namespace") ?? readEnv("CHASE_SETS_KUBERNETES_NAMESPACE", env),
    kubectlPath: readOption(argv, "--kubectl") ?? readEnv("KUBECTL_PATH", env) ?? "kubectl",
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env),
    retryAttempts: parseBoundedInteger(
      readOption(argv, "--retry-attempts") ?? readEnv("MANAGED_POSTGRES_CA_RETRY_ATTEMPTS", env),
      DEFAULT_CA_RETRY_ATTEMPTS,
      1,
      MAX_CA_RETRY_ATTEMPTS,
    ),
    retryBackoffMs: parseBoundedInteger(
      readOption(argv, "--retry-backoff-ms") ?? readEnv("MANAGED_POSTGRES_CA_RETRY_BACKOFF_MS", env),
      DEFAULT_CA_RETRY_BACKOFF_MS,
      0,
      MAX_CA_RETRY_BACKOFF_MS,
    ),
    failureOutputPath: readOption(argv, "--failure-output") ?? readEnv("MANAGED_POSTGRES_CA_FAILURE_OUTPUT", env),
    inventoryOutputPath:
      readOption(argv, "--inventory-output") ?? readEnv("MANAGED_POSTGRES_CONTEXT_INVENTORY_OUTPUT", env),
  };
}

export function buildManagedPostgresAuthorityFailure(options, error) {
  const fields = safeFailureFields(error?.classification ?? "managed-postgres-trust-export-failed", error);
  return {
    result: "failure",
    mode: options?.mode ?? "url-export",
    environment: options?.environmentName ?? "unknown",
    class: error?.failureClass ?? fields.classification,
    attempts: Number.isInteger(error?.attempts) ? error.attempts : 0,
    ...(fields.status === undefined ? {} : { status: fields.status }),
    ...(fields.code === undefined ? {} : { code: fields.code }),
    ...(fields.context === undefined ? {} : { context: fields.context }),
  };
}

export async function reconcileManagedPostgresCaSecret(options, dependencies = {}) {
  const read = dependencies.readFile ?? readFile;
  const writeCa = dependencies.writeCa ?? writeManagedPostgresCa;
  const remove = dependencies.rm ?? rm;
  const append = dependencies.appendFile ?? appendFile;
  const apply = dependencies.applyManagedPostgresCaSecret ?? applyManagedPostgresCaSecret;
  const errors = validateTrustOnlyOptions(options);
  if (errors.length > 0) {
    throw trustError("managed-postgres-trust-only-input-invalid", errors.join("\n"));
  }

  let operationError;
  let attemptsMade = 0;
  try {
    const state = parseTerraformState(await read(options.statePath, "utf8"));
    const clusterId = managedPostgresClusterIdFromTerraformState(state, options.environmentName);
    const certificate = await fetchDigitalOceanManagedPostgresCa(
      {
        clusterId,
        digitalOceanToken: options.digitalOceanToken,
        onAttempt: (attempt) => {
          attemptsMade = attempt;
          dependencies.onAttempt?.(attempt);
        },
      },
      dependencies,
    );
    await writeCa(options.caPath, certificate);
    const certificateBytes = await read(options.caPath);
    const digest = createHash("sha256").update(certificateBytes).digest("hex");
    await apply({
      namespace: options.namespace,
      certificate: certificateBytes,
      kubectlPath: options.kubectlPath,
      spawn: dependencies.spawn,
    });
    await append(options.githubOutputPath, `managed-postgres-ca-sha256=${digest}\n`);
    return { digest };
  } catch (error) {
    operationError = error;
    if (!Number.isInteger(error?.attempts) && attemptsMade > 0) error.attempts = attemptsMade;
    throw error;
  } finally {
    try {
      await remove(options.caPath, { force: true });
    } catch (cleanupError) {
      if (!operationError) {
        throw trustError("managed-postgres-ca-cleanup-failed", "Managed Postgres CA cleanup failed.", {
          code: cleanupError?.code,
        });
      }
    }
  }
}

export async function exportTerraformStateDatabaseUrls(options, dependencies = {}) {
  const read = dependencies.readFile ?? readFile;
  const append = dependencies.appendFile ?? appendFile;
  const writeCa = dependencies.writeCa ?? writeManagedPostgresCa;
  const remove = dependencies.rm ?? rm;
  const log = dependencies.log ?? console.log;
  const errors = validateExportOptions(options);
  if (errors.length > 0) {
    throw trustError("managed-postgres-export-input-invalid", errors.join("\n"));
  }

  let attemptsMade = 0;
  try {
    const state = parseTerraformState(await read(options.statePath, "utf8"));
    const pooledSelection = options.selectionMode === "pooled-only";
    if (pooledSelection && options.inventoryOutputPath) {
      const writeInventoryFile = dependencies.writeFile ?? writeFile;
      await writeInventoryFile(
        options.inventoryOutputPath,
        `${JSON.stringify(pooledContextInventory(state, options.environmentName))}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
    const urls = pooledSelection
      ? databaseUrlsFromTerraformState(state, {
          contexts: options.contexts,
          environmentName: options.environmentName,
          connectionMode: options.connectionMode,
          selectionMode: options.selectionMode,
          caPath: options.caPath,
        })
      : undefined;
    const clusterId = managedPostgresClusterIdFromTerraformState(state, options.environmentName);
    const certificate = await fetchDigitalOceanManagedPostgresCa(
      {
        clusterId,
        digitalOceanToken: options.digitalOceanToken,
        retryAttempts: options.retryAttempts,
        retryBackoffMs: options.retryBackoffMs,
        onAttempt: (attempt) => {
          attemptsMade = attempt;
          dependencies.onAttempt?.(attempt);
        },
      },
      dependencies,
    );
    const selectedUrls =
      urls ??
      databaseUrlsFromTerraformState(state, {
        contexts: options.contexts,
        environmentName: options.environmentName,
        connectionMode: options.connectionMode,
        selectionMode: options.selectionMode,
        caPath: options.caPath,
      });
    const lines = githubEnvLinesForDatabaseUrls(selectedUrls, options.caPath);

    for (const { url } of selectedUrls) {
      log(`::add-mask::${url}`);
    }
    await writeCa(options.caPath, certificate);
    await append(options.githubEnvPath, `${lines.join("\n")}\n`);
    return selectedUrls;
  } catch (error) {
    await remove(options.caPath, { force: true }).catch(() => undefined);
    if (!Number.isInteger(error?.attempts) && attemptsMade > 0) error.attempts = attemptsMade;
    throw error;
  }
}

export function databaseUrlsFromTerraformState(state, options = {}) {
  const environmentName = options.environmentName ?? "staging";
  if (!options.caPath) {
    throw trustError("managed-postgres-ca-path-missing", "A managed PostgreSQL CA path is required.");
  }
  const resources = Array.isArray(state?.resources) ? state.resources : [];
  const cluster = resources.find(
    (resource) => resource.type === "digitalocean_database_cluster" && resource.name === "postgres",
  );
  const databases = resources.find(
    (resource) => resource.type === "digitalocean_database_db" && resource.name === "contexts",
  );
  const users = resources.find(
    (resource) => resource.type === "digitalocean_database_user" && resource.name === "contexts",
  );
  const pools = resources.find(
    (resource) => resource.type === "digitalocean_database_connection_pool" && resource.name === "contexts",
  );
  const connectionMode = options.connectionMode ?? "direct";
  const clusterAttrs = cluster?.instances?.[0]?.attributes ?? {};
  if (!["direct", "pooled"].includes(connectionMode)) {
    throw trustError(
      "managed-postgres-state-invalid",
      `Unsupported Terraform state database connection mode '${connectionMode}'.`,
    );
  }
  if (connectionMode === "direct" && (!clusterAttrs.host || !clusterAttrs.port)) {
    throw trustError(
      "managed-postgres-state-invalid",
      `${environmentLabel(environmentName)} Terraform state does not contain a usable DigitalOcean database cluster.`,
    );
  }

  const databaseByContext = indexedResourceMap(databases);
  const userByContext = indexedResourceMap(users);
  const poolByContext = indexedResourceMap(pools);
  const selectionMode = options.selectionMode ?? "all";
  if (!["all", "pooled-only"].includes(selectionMode)) {
    throw trustError(
      "managed-postgres-state-invalid",
      `Unsupported Terraform state database selection mode '${selectionMode}'.`,
    );
  }
  if (selectionMode === "pooled-only" && connectionMode !== "pooled") {
    throw trustError(
      "managed-postgres-state-invalid",
      "Pooled-only Terraform state selection requires pooled connections.",
    );
  }
  const contextNames = contextNamesForSelection(
    options.contexts,
    databaseByContext,
    userByContext,
    poolByContext,
    environmentName,
    selectionMode,
  );

  return contextNames.map((contextName) => {
    const database = databaseByContext.get(contextName);
    const user = userByContext.get(contextName);
    const pool = poolByContext.get(contextName);
    const connection = connectionMode === "pooled" ? pool : { host: clusterAttrs.host, port: clusterAttrs.port };
    const username = connectionMode === "pooled" ? pool?.user || user?.name : user?.name;
    const password = connectionMode === "pooled" ? pool?.password || user?.password : user?.password;
    const databaseName = connectionMode === "pooled" ? pool?.name : database?.name;
    if (!contextName || !databaseName || !connection?.host || !connection?.port || !username || !password) {
      throw trustError(
        "managed-postgres-state-invalid",
        selectionMode === "pooled-only"
          ? `Terraform state is missing a transaction pool for '${contextName ?? "unknown"}'.`
          : `Terraform state is missing database/user data for '${contextName ?? "unknown"}'.`,
        selectionMode === "pooled-only" ? { context: contextName ?? "unknown" } : undefined,
      );
    }
    if (
      connectionMode === "pooled" &&
      (selectionMode === "pooled-only" ? pool.mode !== "transaction" : pool.mode && pool.mode !== "transaction")
    ) {
      throw trustError(
        "managed-postgres-state-invalid",
        `Terraform state database pool for '${contextName}' is not a transaction pool.`,
        selectionMode === "pooled-only" ? { context: contextName } : undefined,
      );
    }

    const url =
      `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}` +
      `@${connection.host}:${connection.port}/${encodeURIComponent(databaseName)}`;
    return {
      contextName,
      envName: envNameForContext(contextName),
      url: managedPostgresConnectionUrl(url, options.caPath),
    };
  });
}

export function managedPostgresConnectionUrl(connectionString, caPath) {
  if (!caPath) {
    throw trustError("managed-postgres-ca-path-missing", "A managed PostgreSQL CA path is required.");
  }
  const url = new URL(connectionString);
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", caPath);
  url.searchParams.set("uselibpqcompat", "true");
  return url.toString();
}

export function githubEnvLinesForDatabaseUrls(urls, caPath) {
  return [`PGSSLROOTCERT=${caPath}`, ...urls.map(({ envName, url }) => `${envName}=${url}`)];
}

export function managedPostgresClusterIdFromTerraformState(state, environmentName = "staging") {
  const resources = Array.isArray(state?.resources) ? state.resources : [];
  const cluster = resources.find(
    (resource) => resource.type === "digitalocean_database_cluster" && resource.name === "postgres",
  );
  const clusterId = cluster?.instances?.[0]?.attributes?.id;
  if (!clusterId) {
    throw trustError(
      "terraform-state-missing-cluster-id",
      `${environmentLabel(environmentName)} Terraform state does not contain a DigitalOcean database cluster ID.`,
    );
  }
  return String(clusterId);
}

export async function fetchDigitalOceanManagedPostgresCa(options, dependencies = {}) {
  if (!options.digitalOceanToken) {
    throw trustError("missing-digitalocean-token", "DIGITALOCEAN_ACCESS_TOKEN is required.");
  }
  const request = dependencies.fetch ?? fetch;
  const apiBaseUrl = dependencies.apiBaseUrl ?? DIGITALOCEAN_API_BASE_URL;
  const retryAttempts = parseBoundedInteger(options.retryAttempts, DEFAULT_CA_RETRY_ATTEMPTS, 1, MAX_CA_RETRY_ATTEMPTS);
  const retryBackoffMs = parseBoundedInteger(
    options.retryBackoffMs,
    DEFAULT_CA_RETRY_BACKOFF_MS,
    0,
    MAX_CA_RETRY_BACKOFF_MS,
  );
  const sleep = dependencies.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  let response;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    attemptsMade = attempt;
    options.onAttempt?.(attempt);
    try {
      response = await request(`${apiBaseUrl}/databases/${encodeURIComponent(options.clusterId)}/ca`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.digitalOceanToken}`,
        },
      });
    } catch (error) {
      if (attempt === retryAttempts) {
        throw trustError("digitalocean-ca-request-failed", "DigitalOcean database CA request failed.", {
          attempts: attempt,
          code: error?.code ?? error?.cause?.code,
          failureClass: "transient",
        });
      }
      await sleep(retryBackoffMs * attempt);
      continue;
    }
    if (response.ok) break;
    if (isTransientProviderStatus(response.status)) {
      if (attempt === retryAttempts) {
        throw trustError(
          "digitalocean-ca-request-rejected",
          "DigitalOcean database CA provider request exhausted retries.",
          { attempts: attempt, status: response.status, failureClass: "transient" },
        );
      }
      await sleep(retryBackoffMs * attempt);
      continue;
    }
    throw trustError("digitalocean-ca-request-rejected", "DigitalOcean database CA request was rejected.", {
      attempts: attempt,
      status: response.status,
    });
  }
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw trustError(
      "digitalocean-ca-response-invalid",
      "DigitalOcean database CA response content type was invalid.",
      {
        status: response.status,
        attempts: attemptsMade,
      },
    );
  }

  const contentLength = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > DIGITALOCEAN_CA_RESPONSE_MAX_BYTES) {
    throw trustError("digitalocean-ca-response-too-large", "DigitalOcean database CA response exceeded the limit.", {
      status: response.status,
      attempts: attemptsMade,
    });
  }
  let payload;
  try {
    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody, "utf8") > DIGITALOCEAN_CA_RESPONSE_MAX_BYTES) {
      throw trustError("digitalocean-ca-response-too-large", "DigitalOcean database CA response exceeded the limit.", {
        status: response.status,
        attempts: attemptsMade,
      });
    }
    payload = JSON.parse(responseBody);
  } catch (error) {
    if (error?.classification) {
      throw error;
    }
    throw trustError("digitalocean-ca-response-invalid", "DigitalOcean database CA response was invalid.", {
      status: response.status,
      attempts: attemptsMade,
    });
  }
  const encodedCertificate = payload?.ca?.certificate;
  if (typeof encodedCertificate !== "string") {
    throw trustError("digitalocean-ca-response-invalid", "DigitalOcean database CA response omitted the certificate.", {
      status: response.status,
      attempts: attemptsMade,
    });
  }
  const certificate = Buffer.from(encodedCertificate, "base64").toString("utf8");
  if (!/^-----BEGIN CERTIFICATE-----\r?\n[\s\S]+\r?\n-----END CERTIFICATE-----\r?\n?$/.test(certificate)) {
    throw trustError(
      "digitalocean-ca-response-invalid",
      "DigitalOcean database CA response was not a PEM certificate.",
      {
        status: response.status,
        attempts: attemptsMade,
      },
    );
  }
  return certificate;
}

function isTransientProviderStatus(status) {
  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

export async function writeManagedPostgresCa(caPath, certificate) {
  let handle;
  try {
    handle = await open(caPath, "w", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(certificate, { encoding: "utf8" });
  } finally {
    await handle?.close();
  }
}

function contextNamesForSelection(
  contexts,
  databaseByContext,
  userByContext,
  poolByContext,
  environmentName,
  selectionMode,
) {
  if (Array.isArray(contexts) && contexts.length > 0) {
    if (selectionMode === "pooled-only") {
      const invalidContext = contexts.find((contextName) => poolByContext.get(contextName)?.mode !== "transaction");
      if (invalidContext) {
        throw trustError(
          "managed-postgres-state-invalid",
          `Terraform state does not contain a transaction pool for '${invalidContext}'.`,
          { context: invalidContext },
        );
      }
    }
    return contexts;
  }

  const contextNames =
    selectionMode === "pooled-only"
      ? [...poolByContext.entries()]
          .filter(([, pool]) => pool.mode === "transaction")
          .map(([contextName]) => contextName)
          .sort()
      : [...new Set([...databaseByContext.keys(), ...userByContext.keys()])].sort();
  if (contextNames.length === 0) {
    if (selectionMode === "pooled-only") {
      throw trustError(
        "managed-postgres-state-invalid",
        "Terraform state does not contain transaction-pooled contexts.",
        {
          context: "unknown",
        },
      );
    }
    throw trustError(
      "managed-postgres-state-invalid",
      `${environmentLabel(environmentName)} Terraform state does not contain context database users and databases.`,
    );
  }
  return contextNames;
}

function pooledContextInventory(state, environmentName) {
  const resources = Array.isArray(state?.resources) ? state.resources : [];
  const databases = indexedResourceMap(
    resources.find((resource) => resource.type === "digitalocean_database_db" && resource.name === "contexts"),
  );
  const users = indexedResourceMap(
    resources.find((resource) => resource.type === "digitalocean_database_user" && resource.name === "contexts"),
  );
  const pools = indexedResourceMap(
    resources.find(
      (resource) => resource.type === "digitalocean_database_connection_pool" && resource.name === "contexts",
    ),
  );
  const contexts = [...new Set([...databases.keys(), ...users.keys(), ...pools.keys()])]
    .filter((context) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(context))
    .sort()
    .map((context) => ({
      context,
      database: databases.has(context),
      user: users.has(context),
      pool: pools.has(context),
      poolMode: ["transaction", "session", "statement"].includes(pools.get(context)?.mode)
        ? pools.get(context).mode
        : null,
    }));
  return { environment: environmentName, contexts };
}

function indexedResourceMap(resource) {
  return new Map(
    (resource?.instances ?? []).map((instance) => [String(instance.index_key ?? ""), instance.attributes ?? {}]),
  );
}

function envNameForContext(contextName) {
  if (contextName === "control") {
    return "PLATFORM_CONTROL_DATABASE_URL";
  }
  return `DATABASE_URL_${String(contextName).toUpperCase().replaceAll("-", "_")}`;
}

function validateExportOptions(options) {
  const errors = [];
  if (!options.statePath) {
    errors.push("TERRAFORM_STATE_PATH or --state is required.");
  }
  if (!options.githubEnvPath) {
    errors.push("GITHUB_ENV or --github-env is required.");
  }
  if (!options.caPath) {
    errors.push("RUNNER_TEMP, MANAGED_POSTGRES_CA_PATH, or --ca-path is required.");
  }
  if (!options.digitalOceanToken) {
    errors.push("DIGITALOCEAN_ACCESS_TOKEN is required.");
  }
  return errors;
}

function validateTrustOnlyOptions(options) {
  const errors = [];
  if (options.mode !== "trust-only-kubernetes-secret") {
    errors.push("The managed Postgres trust-only mode is required.");
  }
  if (options.contextsSpecified || options.connectionModeSpecified || options.selectionModeSpecified) {
    errors.push("Trust-only mode refuses URL-export contexts, connection-mode, and selection-mode inputs.");
  }
  if (!options.statePath) errors.push("TERRAFORM_STATE_PATH or --state is required.");
  if (!options.githubOutputPath) errors.push("GITHUB_OUTPUT or --github-output is required.");
  if (!options.caPath) errors.push("RUNNER_TEMP, MANAGED_POSTGRES_CA_PATH, or --ca-path is required.");
  if (!options.digitalOceanToken) errors.push("DIGITALOCEAN_ACCESS_TOKEN is required.");
  if (!options.namespace) errors.push("CHASE_SETS_KUBERNETES_NAMESPACE or --namespace is required.");
  if (!options.kubectlPath) errors.push("KUBECTL_PATH or --kubectl is required.");
  if (!["staging", "production"].includes(options.environmentName)) {
    errors.push("Trust-only mode supports only staging or production.");
  }
  return errors;
}

function parseContexts(value) {
  if (!value || value === "all") {
    return null;
  }
  return [
    ...new Set(
      String(value)
        .split(",")
        .map((context) => context.trim())
        .filter(Boolean),
    ),
  ];
}

function environmentLabel(environmentName) {
  return String(environmentName || "Terraform").replace(/^./, (char) => char.toUpperCase());
}

function parseBoundedInteger(value, fallback, minimum, maximum) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export async function main(argv, env = process.env, dependencies = {}) {
  let options;
  try {
    options = parseTerraformStateDatabaseUrlArgs(argv, env);
    if (options.mode === "trust-only-kubernetes-secret") {
      await reconcileManagedPostgresCaSecret(options, dependencies);
    } else if (options.mode === "url-export") {
      await exportTerraformStateDatabaseUrls(options, dependencies);
    } else {
      throw trustError("managed-postgres-authority-mode-invalid", "Unsupported managed Postgres authority mode.");
    }
    return 0;
  } catch (error) {
    const fields = safeFailureFields(error?.classification ?? "managed-postgres-trust-export-failed", error);
    const failure = buildManagedPostgresAuthorityFailure(options, error);
    if (options?.failureOutputPath) {
      const writeFailure = dependencies.writeFile ?? writeFile;
      await writeFailure(options.failureOutputPath, `${JSON.stringify(failure)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      }).catch(() => undefined);
    }
    (dependencies.errorLog ?? console.error)(JSON.stringify(fields));
    return 1;
  }
}

function parseTerraformState(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw trustError("terraform-state-invalid", "Terraform state was not valid JSON.");
  }
}

function trustError(classification, message, fields = {}) {
  return Object.assign(new Error(message), { classification, ...fields });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
