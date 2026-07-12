#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";

export function parseTerraformStateDatabaseUrlArgs(argv, env = process.env) {
  return {
    statePath: readOption(argv, "--state") ?? readEnv("TERRAFORM_STATE_PATH", env),
    githubEnvPath: readOption(argv, "--github-env") ?? readEnv("GITHUB_ENV", env),
    environmentName: readOption(argv, "--environment") ?? readEnv("DEPLOYMENT_ENVIRONMENT", env) ?? "staging",
    contexts: parseContexts(readOption(argv, "--contexts") ?? readEnv("TERRAFORM_STATE_DATABASE_URL_CONTEXTS", env)),
    connectionMode:
      readOption(argv, "--connection-mode") ?? readEnv("TERRAFORM_STATE_DATABASE_URL_CONNECTION_MODE", env) ?? "direct",
  };
}

export async function exportTerraformStateDatabaseUrls(options, dependencies = {}) {
  const read = dependencies.readFile ?? readFile;
  const append = dependencies.appendFile ?? appendFile;
  const log = dependencies.log ?? console.log;
  const errors = validateExportOptions(options);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  const state = JSON.parse(await read(options.statePath, "utf8"));
  const urls = databaseUrlsFromTerraformState(state, {
    contexts: options.contexts,
    environmentName: options.environmentName,
    connectionMode: options.connectionMode,
  });
  const lines = githubEnvLinesForDatabaseUrls(urls);

  for (const { url } of urls) {
    log(`::add-mask::${url}`);
  }
  await append(options.githubEnvPath, `${lines.join("\n")}\n`);

  return urls;
}

export function databaseUrlsFromTerraformState(state, options = {}) {
  const environmentName = options.environmentName ?? "staging";
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
      `@${connection.host}:${connection.port}/${encodeURIComponent(databaseName)}?sslmode=require`;
    return {
      contextName,
      envName: envNameForContext(contextName),
      url,
    };
  });
}

export function githubEnvLinesForDatabaseUrls(urls) {
  return urls.map(({ envName, url }) => `${envName}=${url}`);
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
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
