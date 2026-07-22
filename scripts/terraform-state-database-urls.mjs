#!/usr/bin/env node
import { appendFile, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { safeFailureFields } from "./lib/postgres-connection.mjs";

const DIGITALOCEAN_API_BASE_URL = "https://api.digitalocean.com/v2";

export function parseTerraformStateDatabaseUrlArgs(argv, env = process.env) {
  return {
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
    contexts: parseContexts(readOption(argv, "--contexts") ?? readEnv("TERRAFORM_STATE_DATABASE_URL_CONTEXTS", env)),
    connectionMode:
      readOption(argv, "--connection-mode") ?? readEnv("TERRAFORM_STATE_DATABASE_URL_CONNECTION_MODE", env) ?? "direct",
  };
}

export async function exportTerraformStateDatabaseUrls(options, dependencies = {}) {
  const read = dependencies.readFile ?? readFile;
  const append = dependencies.appendFile ?? appendFile;
  const writeCa = dependencies.writeCa ?? writeManagedPostgresCa;
  const remove = dependencies.rm ?? rm;
  const log = dependencies.log ?? console.log;
  const errors = validateExportOptions(options);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  const state = parseTerraformState(await read(options.statePath, "utf8"));
  const clusterId = managedPostgresClusterIdFromTerraformState(state, options.environmentName);
  const certificate = await fetchDigitalOceanManagedPostgresCa(
    {
      clusterId,
      digitalOceanToken: options.digitalOceanToken,
    },
    dependencies,
  );
  const urls = databaseUrlsFromTerraformState(state, {
    contexts: options.contexts,
    environmentName: options.environmentName,
    connectionMode: options.connectionMode,
    caPath: options.caPath,
  });
  const lines = githubEnvLinesForDatabaseUrls(urls, options.caPath);

  for (const { url } of urls) {
    log(`::add-mask::${url}`);
  }
  try {
    await writeCa(options.caPath, certificate);
    await append(options.githubEnvPath, `${lines.join("\n")}\n`);
  } catch (error) {
    await remove(options.caPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return urls;
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
    throw new Error(`Unsupported Terraform state database connection mode '${connectionMode}'.`);
  }
  if (connectionMode === "direct" && (!clusterAttrs.host || !clusterAttrs.port)) {
    throw new Error(
      `${environmentLabel(environmentName)} Terraform state does not contain a usable DigitalOcean database cluster.`,
    );
  }

  const databaseByContext = indexedResourceMap(databases);
  const userByContext = indexedResourceMap(users);
  const poolByContext = indexedResourceMap(pools);
  const contextNames = contextNamesForSelection(options.contexts, databaseByContext, userByContext, environmentName);

  return contextNames.map((contextName) => {
    const database = databaseByContext.get(contextName);
    const user = userByContext.get(contextName);
    const pool = poolByContext.get(contextName);
    const connection = connectionMode === "pooled" ? pool : { host: clusterAttrs.host, port: clusterAttrs.port };
    const username = connectionMode === "pooled" ? pool?.user || user?.name : user?.name;
    const password = connectionMode === "pooled" ? pool?.password || user?.password : user?.password;
    const databaseName = connectionMode === "pooled" ? pool?.name : database?.name;
    if (!contextName || !databaseName || !connection?.host || !connection?.port || !username || !password) {
      throw new Error(`Terraform state is missing database/user data for '${contextName ?? "unknown"}'.`);
    }
    if (connectionMode === "pooled" && pool.mode && pool.mode !== "transaction") {
      throw new Error(`Terraform state database pool for '${contextName}' is not a transaction pool.`);
    }

    const url =
      `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}` +
      `@${connection.host}:${connection.port}/${encodeURIComponent(databaseName)}`;
    const connectionUrl = new URL(url);
    connectionUrl.searchParams.set("sslmode", "verify-full");
    connectionUrl.searchParams.set("sslrootcert", options.caPath);
    connectionUrl.searchParams.set("uselibpqcompat", "true");
    return {
      contextName,
      envName: envNameForContext(contextName),
      url: connectionUrl.toString(),
    };
  });
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
  let response;
  try {
    response = await request(`${apiBaseUrl}/databases/${encodeURIComponent(options.clusterId)}/ca`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.digitalOceanToken}`,
      },
    });
  } catch {
    throw trustError("digitalocean-ca-request-failed", "DigitalOcean database CA request failed.");
  }
  if (!response.ok) {
    throw trustError("digitalocean-ca-request-rejected", "DigitalOcean database CA request was rejected.", {
      status: response.status,
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw trustError("digitalocean-ca-response-invalid", "DigitalOcean database CA response was invalid.", {
      status: response.status,
    });
  }
  const encodedCertificate = payload?.ca?.certificate;
  if (typeof encodedCertificate !== "string") {
    throw trustError("digitalocean-ca-response-invalid", "DigitalOcean database CA response omitted the certificate.", {
      status: response.status,
    });
  }
  const certificate = Buffer.from(encodedCertificate, "base64").toString("utf8");
  if (!/^-----BEGIN CERTIFICATE-----\r?\n[\s\S]+\r?\n-----END CERTIFICATE-----\r?\n?$/.test(certificate)) {
    throw trustError(
      "digitalocean-ca-response-invalid",
      "DigitalOcean database CA response was not a PEM certificate.",
      {
        status: response.status,
      },
    );
  }
  return certificate;
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

function contextNamesForSelection(contexts, databaseByContext, userByContext, environmentName) {
  if (Array.isArray(contexts) && contexts.length > 0) {
    return contexts;
  }

  const contextNames = [...new Set([...databaseByContext.keys(), ...userByContext.keys()])].sort();
  if (contextNames.length === 0) {
    throw new Error(
      `${environmentLabel(environmentName)} Terraform state does not contain context database users and databases.`,
    );
  }
  return contextNames;
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

function parseContexts(value) {
  if (!value || value === "all") {
    return null;
  }
  return String(value)
    .split(",")
    .map((context) => context.trim())
    .filter(Boolean);
}

function environmentLabel(environmentName) {
  return String(environmentName || "Terraform").replace(/^./, (char) => char.toUpperCase());
}

async function main(argv, env = process.env) {
  try {
    await exportTerraformStateDatabaseUrls(parseTerraformStateDatabaseUrlArgs(argv, env));
    return 0;
  } catch (error) {
    console.error(
      JSON.stringify(safeFailureFields(error?.classification ?? "managed-postgres-trust-export-failed", error)),
    );
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
