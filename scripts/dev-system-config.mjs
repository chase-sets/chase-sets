import { buildMinimalProcessEnvironment } from "./lib/process.mjs";

const representativeSnapshotEnvironmentNames = Object.freeze([
  "CATALOG_ASSET_LOCAL_ROOT",
  "REPRESENTATIVE_CATALOG_PACK_MANIFEST_KEYS",
  "REPRESENTATIVE_CATALOG_PACK_SOURCE",
  "REPRESENTATIVE_SNAPSHOT_CACHE_DIR",
  "REPRESENTATIVE_SNAPSHOT_STORAGE_DIR",
  "REPRESENTATIVE_SNAPSHOT_TARGET",
  "SEED_PACKS_SPACES_ACCESS_ID",
  "SEED_PACKS_SPACES_BUCKET",
  "SEED_PACKS_SPACES_ENDPOINT",
  "SEED_PACKS_SPACES_REGION",
  "SEED_PACKS_SPACES_SECRET_KEY",
]);

const representativeSandboxEnvironmentNames = Object.freeze([
  "CHASE_SETS_SANDBOX_BASE_PORT",
  "CHASE_SETS_SANDBOX_ENV_FILE",
  "CHASE_SETS_SANDBOX_ID",
]);

const platformBootstrapSelectorNames = Object.freeze([
  "PLATFORM_DATA_PROFILES",
  "REPRESENTATIVE_CATALOG_PACK_SOURCE",
  "REPRESENTATIVE_CATALOG_REPLAY_EVIDENCE_OUT",
]);

function isSpaceCredentialName(name) {
  return name.startsWith("RELEASE_EVIDENCE_SPACES_") || name.startsWith("SEED_PACKS_SPACES_");
}

function isDatabaseUrlName(name) {
  return (
    name === "DATABASE_URL" ||
    name === "TEST_DATABASE_URL" ||
    name.startsWith("DATABASE_URL_") ||
    name.endsWith("_DATABASE_URL")
  );
}

function isPotentialDatabaseSelectorName(name) {
  return name.startsWith("PG") || isDatabaseUrlName(name) || /(?:^|_)(?:DATABASE|DB|POSTGRES)(?:_|$)/.test(name);
}

function requireLocalExplicitDatabaseUrl(name, value) {
  if (!isDatabaseUrlName(name) || value === "") {
    return;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a local sandbox PostgreSQL URL.`);
  }
  if (url.protocol !== "postgresql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(`${name} must be a local sandbox PostgreSQL URL.`);
  }
}

function shouldRemovePlatformChildValue(name) {
  const normalized = name.toUpperCase();
  return isSpaceCredentialName(normalized) || isPotentialDatabaseSelectorName(normalized);
}

export function buildPlatformChildEnvironment(baseEnvironment, explicitEnvironment, { minimalBase = false } = {}) {
  const base = minimalBase
    ? buildMinimalProcessEnvironment(baseEnvironment)
    : Object.fromEntries(Object.entries(baseEnvironment).filter(([name]) => !shouldRemovePlatformChildValue(name)));
  const explicit = {};
  for (const [name, value] of Object.entries(explicitEnvironment)) {
    const normalized = name.toUpperCase();
    if (isSpaceCredentialName(normalized)) {
      continue;
    }
    if (isDatabaseUrlName(normalized)) {
      requireLocalExplicitDatabaseUrl(normalized, value);
    } else if (isPotentialDatabaseSelectorName(normalized)) {
      continue;
    }
    explicit[name] = value;
  }
  return { ...base, ...explicit };
}

export function applyCurrentPlatformBootstrapSelectors(explicitEnvironment, currentEnvironment) {
  const result = { ...explicitEnvironment };
  for (const name of platformBootstrapSelectorNames) {
    if (currentEnvironment[name] !== undefined) {
      result[name] = currentEnvironment[name];
    }
  }
  return result;
}

export function buildRepresentativeSnapshotCommandEnvironment(baseEnvironment, sandboxEnvironment) {
  const explicit = {};
  for (const name of representativeSandboxEnvironmentNames) {
    if (sandboxEnvironment[name] !== undefined) {
      explicit[name] = sandboxEnvironment[name];
    }
  }
  for (const name of representativeSnapshotEnvironmentNames) {
    if (baseEnvironment[name] !== undefined) {
      explicit[name] = baseEnvironment[name];
    }
  }
  return buildMinimalProcessEnvironment(baseEnvironment, explicit);
}

export const browserE2eRateLimitEnv = Object.freeze({
  CHASE_SETS_RATE_LIMITS_DISABLED: "true",
});

export const browserE2ePlatformAdminEnv = Object.freeze({
  PLATFORM_ADMIN_EMAIL: "browser-e2e-platform-admin@chasesets.test",
  PLATFORM_ADMIN_PASSWORD: "browser-e2e-platform-admin-password",
});

export const browserE2eReadConsistencyEnv = Object.freeze({
  READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED: "true",
});

export const browserE2eProductionIngressEnv = Object.freeze({
  CHASE_SETS_TRUST_FORWARDED_HEADERS: "true",
});

export const browserE2ePlatformWorkerEnv = Object.freeze({
  // The support shard invokes this sweep explicitly and asserts its result.
  // Running the scheduled copy at worker startup consumes the fixtures first.
  SUPPORT_REQUEST_DEADLINE_SWEEP_INTERVAL_MS: "0",
});

export const browserE2ePlatformWorkerCiCommand = Object.freeze({
  command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  args: Object.freeze(["--filter", "@chase-sets/app-platform-worker", "run", "dev:ci"]),
});

const packageManagerCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export const browserE2eProductionTarget = "browser-e2e-production";

export const browserE2eProductionCommands = Object.freeze({
  "platform-api": Object.freeze({
    command: packageManagerCommand,
    args: Object.freeze(["--filter", "@chase-sets/app-platform-api", "run", "start"]),
  }),
  "platform-worker": Object.freeze({
    command: packageManagerCommand,
    args: Object.freeze(["--filter", "@chase-sets/app-platform-worker", "run", "start"]),
  }),
  "admin-web": Object.freeze({
    command: packageManagerCommand,
    args: Object.freeze(["--filter", "@chase-sets/app-admin-web", "run", "start"]),
  }),
  marketplace: Object.freeze({
    command: packageManagerCommand,
    args: Object.freeze(["--filter", "@chase-sets/app-marketplace-web", "run", "start"]),
  }),
});

export const browserE2eProductionBuilds = Object.freeze([
  Object.freeze({ name: "admin-web", workspace: "@chase-sets/app-admin-web" }),
  Object.freeze({ name: "marketplace", workspace: "@chase-sets/app-marketplace-web" }),
]);

const browserE2eProductionWebOriginPortOffset = 4;
const browserE2eProductionWebNames = new Set(browserE2eProductionBuilds.map(({ name }) => name));

export const browserE2eDirectCiCommands = Object.freeze({
  "platform-worker": browserE2ePlatformWorkerCiCommand,
});

export function resolveBrowserE2eSystemTarget(environment = process.env) {
  const mode = environment.CHASE_SETS_BROWSER_E2E_SYSTEM ?? "development";
  if (mode === "development") {
    return "browser-e2e";
  }
  if (mode === "production") {
    return browserE2eProductionTarget;
  }
  throw new Error(`CHASE_SETS_BROWSER_E2E_SYSTEM must be "development" or "production"; received "${mode}".`);
}

export function isBrowserE2eTarget(targetName) {
  return targetName === "browser-e2e" || targetName === browserE2eProductionTarget;
}

export function acquireDevSystemHeavySlot(mode, targetName, acquireSlot) {
  if (mode !== "dev" || !isBrowserE2eTarget(targetName)) return false;
  return acquireSlot("script-battery");
}

export function createBrowserE2eProductionIngressDefinitions(processDefinitions, { apiUrl, ingressScriptPath }) {
  return processDefinitions
    .filter((definition) => browserE2eProductionWebNames.has(definition.name))
    .map((definition) => ({
      name: `${definition.name}-ingress`,
      command: "node",
      args: [
        ingressScriptPath,
        "--port",
        String(definition.publicPort),
        "--label",
        definition.name,
        "--web-target",
        `http://127.0.0.1:${definition.port}`,
        "--api-target",
        apiUrl,
      ],
      env: {},
      port: definition.publicPort,
    }));
}

export function applyDevTargetEnvOverrides(targetName, processDefinitions, { ci = Boolean(process.env.CI) } = {}) {
  if (!isBrowserE2eTarget(targetName)) {
    return processDefinitions;
  }

  return processDefinitions.map((definition) => {
    const productionCommand =
      targetName === browserE2eProductionTarget ? browserE2eProductionCommands[definition.name] : undefined;

    if (definition.name === "platform-api") {
      return {
        ...definition,
        env: {
          ...definition.env,
          ...browserE2eRateLimitEnv,
          ...browserE2ePlatformAdminEnv,
          ...browserE2eReadConsistencyEnv,
          ...(targetName === browserE2eProductionTarget ? browserE2eProductionIngressEnv : {}),
        },
        ...(productionCommand ?? (ci ? browserE2eDirectCiCommands[definition.name] : {})),
      };
    }

    if (definition.name === "platform-worker") {
      return {
        ...definition,
        env: {
          ...definition.env,
          ...browserE2ePlatformWorkerEnv,
        },
        ...(productionCommand ?? (ci ? browserE2eDirectCiCommands[definition.name] : {})),
      };
    }

    if (productionCommand) {
      const isProductionWeb = browserE2eProductionWebNames.has(definition.name);
      const originPort = isProductionWeb ? definition.port + browserE2eProductionWebOriginPortOffset : definition.port;
      const internalApiOrigin = definition.env.PLATFORM_API_URL ?? definition.env.VITE_PLATFORM_API_URL;
      if (isProductionWeb && !internalApiOrigin) {
        throw new Error(`${definition.name} requires PLATFORM_API_URL for production browser e2e.`);
      }
      return {
        ...definition,
        env: {
          ...definition.env,
          ...browserE2eProductionIngressEnv,
          CHASE_SETS_INTERNAL_API_ORIGIN: internalApiOrigin,
          PORT: String(originPort),
        },
        ...productionCommand,
        port: originPort,
        publicPort: definition.port,
      };
    }

    if (ci && browserE2eDirectCiCommands[definition.name]) {
      return {
        ...definition,
        ...browserE2eDirectCiCommands[definition.name],
      };
    }

    return definition;
  });
}
