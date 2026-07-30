import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./repo.mjs";

const defaultSandboxEnvFileName = ".env.sandbox.local";
const defaultPortBase = 6200;
const portBlockSize = 50;
const portBlockCount = 100;

const portDefinitions = {
  portal: {
    envName: "CHASE_SETS_PORT_PORTAL",
    offset: 0,
  },
  adminWeb: {
    envName: "CHASE_SETS_PORT_ADMIN_WEB",
    offset: 2,
  },
  marketplaceWeb: {
    envName: "CHASE_SETS_PORT_MARKETPLACE_WEB",
    offset: 3,
  },
  publicWeb: {
    envName: "CHASE_SETS_PORT_PUBLIC_WEB",
    offset: 4,
  },
  platformApi: {
    envName: "CHASE_SETS_PORT_PLATFORM_API",
    offset: 12,
  },
  platformWorker: {
    envName: "CHASE_SETS_PORT_PLATFORM_WORKER",
    offset: 13,
  },
  postgres: {
    envName: "CHASE_SETS_PORT_POSTGRES",
    offset: 20,
  },
  grafana: {
    envName: "CHASE_SETS_PORT_GRAFANA",
    offset: 30,
  },
  prometheus: {
    envName: "CHASE_SETS_PORT_PROMETHEUS",
    offset: 31,
  },
  loki: {
    envName: "CHASE_SETS_PORT_LOKI",
    offset: 32,
  },
  tempo: {
    envName: "CHASE_SETS_PORT_TEMPO",
    offset: 33,
  },
  otelGrpc: {
    envName: "CHASE_SETS_PORT_OTEL_GRPC",
    offset: 34,
  },
  otelHttp: {
    envName: "CHASE_SETS_PORT_OTEL_HTTP",
    offset: 35,
  },
  otelMetrics: {
    envName: "CHASE_SETS_PORT_OTEL_METRICS",
    offset: 36,
  },
  tempoGrpc: {
    envName: "CHASE_SETS_PORT_TEMPO_GRPC",
    offset: 37,
  },
};

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== String(value)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function optionalPositiveInteger(value, label) {
  if (!value) {
    return null;
  }
  return parsePositiveInteger(value, label);
}

function sanitizeIdentifier(value, fallback) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

  return sanitized || fallback;
}

function normalizeDatabaseToken(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function hashHex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashInteger(value) {
  return Number.parseInt(hashHex(value).slice(0, 8), 16);
}

export function normalizeSandboxWorktreeIdentity(rootDir) {
  const value = String(rootDir);
  if (/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value)) {
    return path.win32.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  }
  if (path.posix.isAbsolute(value)) {
    return path.posix.resolve(value).replace(/\/+$/, "");
  }
  return path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "");
}

function readImplementedContextNames(rootDir) {
  const contextsDir = path.join(rootDir, "bounded-contexts");
  if (!existsSync(contextsDir)) {
    return [];
  }

  return readdirSync(contextsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (contextName) =>
        existsSync(path.join(contextsDir, contextName, "context.json")) &&
        existsSync(path.join(contextsDir, contextName, "package.json")),
    )
    .sort((left, right) => left.localeCompare(right, "en"));
}

function createDatabaseUrl(adminDatabaseUrl, roleName, databaseName = roleName) {
  const url = new URL(adminDatabaseUrl);
  url.username = roleName;
  url.password = roleName;
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function createAdminDatabaseUrl(postgresPort) {
  return `postgresql://postgres:postgres@localhost:${postgresPort}/postgres`;
}

function resolvePortBase(rootDir, env) {
  const explicitBase = optionalPositiveInteger(env.CHASE_SETS_SANDBOX_BASE_PORT, "CHASE_SETS_SANDBOX_BASE_PORT");
  if (explicitBase) {
    return explicitBase;
  }

  return defaultPortBase + (hashInteger(normalizeSandboxWorktreeIdentity(rootDir)) % portBlockCount) * portBlockSize;
}

function resolvePorts(rootDir, env) {
  const basePort = resolvePortBase(rootDir, env);
  const ports = {};

  for (const [key, definition] of Object.entries(portDefinitions)) {
    ports[key] = optionalPositiveInteger(env[definition.envName], definition.envName) ?? basePort + definition.offset;
  }

  return { basePort, ports };
}

function formatEnvFile(values) {
  return `${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function formatPathForEnv(value) {
  return value.split(path.sep).join("/");
}

export function readSandboxEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  return Object.fromEntries(
    readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        return separatorIndex === -1 ? [line, ""] : [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      }),
  );
}

export function resolveWorktreeSandbox({
  rootDir = repoRoot,
  env = process.env,
  contextNames = readImplementedContextNames(rootDir),
} = {}) {
  // Worktree identity is cross-host data: Git and Docker labels can describe a
  // Windows worktree while this command runs on Linux. Classify that raw value
  // before the native resolver can reinterpret it as a relative POSIX path.
  const worktreeIdentity = normalizeSandboxWorktreeIdentity(rootDir);
  const resolvedRoot = path.resolve(rootDir);
  const hash = hashHex(worktreeIdentity);
  const explicitId = env.CHASE_SETS_SANDBOX_ID?.trim();
  const sandboxId = sanitizeIdentifier(explicitId || hash.slice(0, 8), "local");
  const composeProjectName = `chase-sets-${sandboxId}`;
  const envFilePath = path.resolve(
    env.CHASE_SETS_SANDBOX_ENV_FILE ?? path.join(resolvedRoot, defaultSandboxEnvFileName),
  );
  const { basePort, ports } = resolvePorts(worktreeIdentity, env);
  const adminDatabaseUrl = createAdminDatabaseUrl(ports.postgres);
  const databasePrefix = normalizeDatabaseToken(`cs_${sandboxId}`);
  const controlDatabaseName = `${databasePrefix}_control`;
  const controlDatabaseUrl = createDatabaseUrl(adminDatabaseUrl, controlDatabaseName);
  const contextDatabaseUrls = Object.fromEntries(
    contextNames.map((contextName) => {
      const databaseName = `${databasePrefix}_${normalizeDatabaseToken(contextName)}`;
      return [contextName, createDatabaseUrl(adminDatabaseUrl, databaseName)];
    }),
  );
  const urls = {
    portal: `http://localhost:${ports.portal}`,
    adminWeb: `http://localhost:${ports.adminWeb}`,
    marketplaceWeb: `http://localhost:${ports.marketplaceWeb}`,
    publicWeb: `http://localhost:${ports.publicWeb}`,
    platformApi: `http://localhost:${ports.platformApi}`,
    platformWorker: `http://localhost:${ports.platformWorker}`,
    grafana: `http://localhost:${ports.grafana}`,
    prometheus: `http://localhost:${ports.prometheus}`,
    loki: `http://localhost:${ports.loki}`,
    tempo: `http://localhost:${ports.tempo}`,
    otelHttp: `http://localhost:${ports.otelHttp}`,
    otelGrpc: `localhost:${ports.otelGrpc}`,
  };
  const observabilityArtifactsPath = path.join(resolvedRoot, "artifacts", "observability", sandboxId);

  return {
    id: sandboxId,
    rootDir: resolvedRoot,
    envFilePath,
    composeProjectName,
    basePort,
    ports,
    urls,
    contextNames,
    adminDatabaseUrl,
    controlDatabaseName,
    controlDatabaseUrl,
    contextDatabaseUrls,
    observabilityArtifactsPath,
  };
}

export function getContextDatabaseEnvName(contextName) {
  return `DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`;
}

export function listSandboxDatabases(sandbox) {
  return [
    { key: "control", databaseUrl: sandbox.controlDatabaseUrl },
    ...Object.entries(sandbox.contextDatabaseUrls)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, databaseUrl]) => ({ key, databaseUrl })),
  ];
}

export function buildSandboxEnv(sandbox) {
  const values = {
    CHASE_SETS_SANDBOX_ID: sandbox.id,
    CHASE_SETS_SANDBOX_ENV_FILE: formatPathForEnv(sandbox.envFilePath),
    CHASE_SETS_SANDBOX_COMPOSE_PROJECT: sandbox.composeProjectName,
    CHASE_SETS_SANDBOX_WORKTREE: normalizeSandboxWorktreeIdentity(sandbox.rootDir),
    CHASE_SETS_SANDBOX_BASE_PORT: String(sandbox.basePort),
    COMPOSE_PROJECT_NAME: sandbox.composeProjectName,
    POSTGRES_DEV_HOST_PORT: String(sandbox.ports.postgres),
    POSTGRES_DEV_ADMIN_DATABASE_URL: sandbox.adminDatabaseUrl,
    POSTGRES_DEV_DATABASE_NAME: sandbox.controlDatabaseName,
    POSTGRES_DEV_DATABASE_URL: sandbox.controlDatabaseUrl,
    PLATFORM_CONTROL_DATABASE_URL: sandbox.controlDatabaseUrl,
    PLATFORM_WORK_SIGNAL_DATABASE_URL: sandbox.controlDatabaseUrl,
    TEST_DATABASE_URL: sandbox.adminDatabaseUrl,
    DEV_PORTAL_PORT: String(sandbox.ports.portal),
    ADMIN_WEB_PORT: String(sandbox.ports.adminWeb),
    MARKETPLACE_WEB_PORT: String(sandbox.ports.marketplaceWeb),
    PUBLIC_WEB_PORT: String(sandbox.ports.publicWeb),
    PLATFORM_API_PORT: String(sandbox.ports.platformApi),
    PLATFORM_WORKER_PORT: String(sandbox.ports.platformWorker),
    DEV_PORTAL_URL: sandbox.urls.portal,
    ADMIN_WEB_URL: sandbox.urls.adminWeb,
    MARKETPLACE_WEB_URL: sandbox.urls.marketplaceWeb,
    PUBLIC_WEB_URL: sandbox.urls.publicWeb,
    LANDING_WEB_URL: sandbox.urls.publicWeb,
    PLATFORM_API_URL: sandbox.urls.platformApi,
    VITE_PLATFORM_API_URL: sandbox.urls.platformApi,
    PLATFORM_WORKER_URL: sandbox.urls.platformWorker,
    GRAFANA_URL: sandbox.urls.grafana,
    PROMETHEUS_URL: sandbox.urls.prometheus,
    LOKI_URL: sandbox.urls.loki,
    TEMPO_URL: sandbox.urls.tempo,
    OTEL_EXPORTER_OTLP_ENDPOINT: sandbox.urls.otelHttp,
    OTEL_EXPORTER_OTLP_GRPC_ENDPOINT: sandbox.urls.otelGrpc,
    CHASE_SETS_OBSERVABILITY_ARTIFACTS: formatPathForEnv(sandbox.observabilityArtifactsPath),
    GRAFANA_HOST_PORT: String(sandbox.ports.grafana),
    PROMETHEUS_HOST_PORT: String(sandbox.ports.prometheus),
    LOKI_HOST_PORT: String(sandbox.ports.loki),
    TEMPO_HOST_PORT: String(sandbox.ports.tempo),
    OTEL_GRPC_HOST_PORT: String(sandbox.ports.otelGrpc),
    OTEL_HTTP_HOST_PORT: String(sandbox.ports.otelHttp),
    OTEL_METRICS_HOST_PORT: String(sandbox.ports.otelMetrics),
    TEMPO_GRPC_HOST_PORT: String(sandbox.ports.tempoGrpc),
    STRIPE_WEBHOOK_FORWARD_URL: `http://host.docker.internal:${sandbox.ports.platformApi}/api/payments/provider/webhooks`,
  };

  for (const [contextName, databaseUrl] of Object.entries(sandbox.contextDatabaseUrls)) {
    values[getContextDatabaseEnvName(contextName)] = databaseUrl;
  }

  return values;
}

export function writeSandboxEnvFile(sandbox, values = buildSandboxEnv(sandbox)) {
  mkdirSync(path.dirname(sandbox.envFilePath), { recursive: true });
  const nextContent = formatEnvFile(values);
  const currentContent = existsSync(sandbox.envFilePath) ? readFileSync(sandbox.envFilePath, "utf8") : null;

  if (currentContent !== nextContent) {
    writeFileSync(sandbox.envFilePath, nextContent, "utf8");
  }

  return values;
}

export function ensureWorktreeSandboxEnvironment(options = {}) {
  const sandbox = resolveWorktreeSandbox(options);
  const env = writeSandboxEnvFile(sandbox, {
    ...readSandboxEnvFile(sandbox.envFilePath),
    ...buildSandboxEnv(sandbox),
  });
  return { sandbox, env };
}

export function applySandboxEnv(values, env = process.env) {
  for (const [key, value] of Object.entries(values)) {
    env[key] = value;
  }
}

export function mergeSandboxEnvFile(updates, { rootDir = repoRoot, env = process.env } = {}) {
  const sandbox = resolveWorktreeSandbox({ rootDir, env });
  const existing = readSandboxEnvFile(sandbox.envFilePath);
  const next = {
    ...existing,
    ...buildSandboxEnv(sandbox),
    ...updates,
  };
  writeSandboxEnvFile(sandbox, next);
  return { sandbox, env: next };
}

export function buildDockerComposeArgs(sandbox, commandArgs = []) {
  return [
    "compose",
    "--env-file",
    sandbox.envFilePath,
    "-f",
    "docker-compose.dev.yml",
    "-p",
    sandbox.composeProjectName,
    ...commandArgs,
  ];
}
