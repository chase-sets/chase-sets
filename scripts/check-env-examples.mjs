#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SHARED_HELPER_ENV_NAMES = {
  loadCatalogAssetStorageConfig: [
    "CATALOG_ASSET_STORAGE_KIND",
    "CATALOG_ASSET_LOCAL_ROOT",
    "CATALOG_ASSET_PUBLIC_BASE_URL",
    "CATALOG_ASSET_S3_BUCKET",
    "CATALOG_ASSET_S3_REGION",
    "CATALOG_ASSET_S3_ENDPOINT",
    "CATALOG_ASSET_S3_ACCESS_KEY_ID",
    "CATALOG_ASSET_S3_SECRET_ACCESS_KEY",
    "CATALOG_ASSET_S3_FORCE_PATH_STYLE",
  ],
  loadPlatformDatabaseConfig: ["DATABASE_URL", "PLATFORM_CONTROL_DATABASE_URL", "PLATFORM_WORK_SIGNAL_DATABASE_URL"],
  loadPoolConfig: ["DATABASE_POOL_MAX", "DATABASE_POOL_IDLE_TIMEOUT_MS", "DATABASE_POOL_CONNECTION_TIMEOUT_MS"],
  loadPostageConfig: ["EASYPOST_API_KEY", "EASYPOST_API_BASE_URL", "EASYPOST_MODE"],
  loadStripeProviderConfig: [
    "STRIPE_SECRET_KEY",
    "STRIPE_PUBLISHABLE_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_CONNECT_WEBHOOK_SECRET",
    "STRIPE_API_BASE_URL",
    "STRIPE_CONNECT_ACCOUNTS_API",
  ],
  loadTcgplayerAutomationConfig: [
    "TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE",
    "TCGPLAYER_AUTOMATION_USER_AGENT",
    "TCGPLAYER_AUTOMATION_DOMAIN_CONFIG_JSON",
    "TCGPLAYER_AUTOMATION_REQUEST_DELAY_MS",
    "TCGPLAYER_AUTOMATION_RATE_LIMIT_COOLDOWN_MS",
    "TCGPLAYER_AUTOMATION_MAX_CONCURRENT_REQUESTS",
    "TCGPLAYER_AUTOMATION_ADAPTIVE_ENABLED",
    "TCGPLAYER_AUTOMATION_MIN_REQUEST_DELAY_MS",
    "TCGPLAYER_AUTOMATION_MAX_REQUEST_DELAY_MS",
    "TCGPLAYER_AUTOMATION_LEARNED_MIN_DELAY_MS",
    "TCGPLAYER_AUTOMATION_ADAPTIVE_INCREASE_MULTIPLIER",
    "TCGPLAYER_AUTOMATION_ADAPTIVE_FLOOR_STEP_MS",
    "TCGPLAYER_AUTOMATION_ADAPTIVE_DECREASE_AMOUNT_MS",
    "TCGPLAYER_AUTOMATION_ADAPTIVE_SUCCESS_THRESHOLD",
    "TCGPLAYER_AUTOMATION_MAX_RETRIES",
  ],
};

const DEPLOYABLES = [
  {
    name: "platform-api",
    configSources: ["deployables/platform-api/src/config.ts", "infrastructure/platform-runtime/http.ts"],
    examplePath: "deployables/platform-api/.env.example",
    helperEnvNames: {
      ...SHARED_HELPER_ENV_NAMES,
      loadPostageConfig: [...SHARED_HELPER_ENV_NAMES.loadPostageConfig, "EASYPOST_WEBHOOK_SECRET"],
    },
    additionalEnvNames: ["PLATFORM_INTERNAL_AUTH_SECRET"],
  },
  {
    name: "platform-worker",
    configSources: ["deployables/platform-worker/src/config.ts"],
    examplePath: "deployables/platform-worker/.env.example",
    helperEnvNames: SHARED_HELPER_ENV_NAMES,
    additionalEnvNames: ["PLATFORM_INTERNAL_AUTH_SECRET"],
  },
];

const IGNORED_PROCESS_ENV_NAMES = new Set(["NODE_ENV"]);

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function extractConstStringBindings(source) {
  const bindings = new Map();
  const pattern = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\s*=\s*"([A-Z][A-Z0-9_]*)"/g;
  for (const match of source.matchAll(pattern)) {
    bindings.set(match[1], match[2]);
  }
  return bindings;
}

function extractEnvNamesFromSource(source, constBindings) {
  const names = new Set();
  const literalCallPattern =
    /\b(?:getOptionalEnv|getBooleanEnv|getBoundedDurationEnv|getOptionalCsvEnv|getOptionalJsonEnv|getOptionalPositiveNumberEnv|getPositiveNumberEnv|getRequiredPositiveNumberEnv|getRequiredNonNegativeNumberEnv|getNonNegativeNumberEnv|getProjectionKeyListEnv)\(\s*"([A-Z][A-Z0-9_]*)"/g;
  const constCallPattern =
    /\b(?:getOptionalEnv|getBooleanEnv|getBoundedDurationEnv|getOptionalCsvEnv|getOptionalJsonEnv|getOptionalPositiveNumberEnv|getPositiveNumberEnv|getRequiredPositiveNumberEnv|getRequiredNonNegativeNumberEnv|getNonNegativeNumberEnv|getProjectionKeyListEnv)\(\s*([A-Z][A-Z0-9_]+)/g;
  const processDotPattern = /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g;
  const processBracketLiteralPattern = /\bprocess\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g;
  const envNamePropertyPattern = /\b[a-zA-Z0-9_]*EnvName:\s*"([A-Z][A-Z0-9_]*)"/g;

  for (const pattern of [literalCallPattern, processDotPattern, processBracketLiteralPattern, envNamePropertyPattern]) {
    for (const match of source.matchAll(pattern)) {
      if (!IGNORED_PROCESS_ENV_NAMES.has(match[1])) {
        names.add(match[1]);
      }
    }
  }

  for (const match of source.matchAll(constCallPattern)) {
    const resolved = constBindings.get(match[1]);
    if (resolved) {
      names.add(resolved);
    }
  }

  return names;
}

function extractUsedHelperNames(source, helperEnvNames) {
  return Object.keys(helperEnvNames).filter((helperName) => new RegExp(`\\b${helperName}\\s*\\(`).test(source));
}

function extractExampleNames(source) {
  const names = new Set();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/);
    if (match) {
      names.add(match[1]);
    }
  }
  return names;
}

export function collectEnvExampleVerification(deployables = DEPLOYABLES) {
  const allSources = deployables.flatMap((deployable) => deployable.configSources.map((path) => readRepoFile(path)));
  const constBindings = new Map(allSources.flatMap((source) => [...extractConstStringBindings(source)]));

  return deployables.map((deployable) => {
    const requiredNames = new Set(deployable.additionalEnvNames);
    const configSource = deployable.configSources.map((path) => readRepoFile(path)).join("\n");
    for (const name of extractEnvNamesFromSource(configSource, constBindings)) {
      requiredNames.add(name);
    }
    for (const helperName of extractUsedHelperNames(configSource, deployable.helperEnvNames)) {
      for (const name of deployable.helperEnvNames[helperName]) {
        requiredNames.add(name);
      }
    }

    const exampleNames = extractExampleNames(readRepoFile(deployable.examplePath));
    const missing = [...requiredNames].filter((name) => !exampleNames.has(name)).sort();

    return {
      deployable: deployable.name,
      examplePath: deployable.examplePath,
      requiredNames: [...requiredNames].sort(),
      exampleNames: [...exampleNames].sort(),
      missing,
    };
  });
}

export function renderEnvExampleVerificationFailures(results) {
  return results
    .filter((result) => result.missing.length > 0)
    .map(
      (result) =>
        `${result.examplePath} is missing ${result.missing.length} config reader env var(s):\n` +
        result.missing.map((name) => `  - ${name}`).join("\n"),
    )
    .join("\n\n");
}

function main() {
  const results = collectEnvExampleVerification();
  const failures = renderEnvExampleVerificationFailures(results);
  if (failures) {
    console.error(failures);
    return 1;
  }

  console.log(`Verified ${results.length} deployable .env.example file(s) against config readers.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
