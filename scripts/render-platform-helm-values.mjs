import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeRelative, repoRoot } from "./lib/repo.mjs";

export const chartValuesRelativePath = "infrastructure/helm/platform/values.yaml";
const platformMainRelativePath = "infrastructure/digitalocean/platform/main.tf";
const platformLocalsRelativePath = "infrastructure/digitalocean/platform/locals.tf";
const generatedBy = "node ./scripts/render-platform-helm-values.mjs";
const bootstrapQuiesceTimeoutSeconds = 45;
const bootstrapCommandTimeoutSeconds = 780;
const bootstrapHookActiveDeadlineSeconds = 890;

const componentOrder = [
  "public-web",
  "marketplace",
  "admin-web",
  "platform-api",
  "platform-worker",
  "platform-bootstrap",
];

const deploymentKindByTerraformKind = {
  service: "service",
  worker: "worker",
  job: "job",
};

const secretEnvFallbacks = new Set([
  "PLATFORM_CONTROL_DATABASE_URL",
  "PLATFORM_WORK_SIGNAL_DATABASE_URL",
  "PLATFORM_INTERNAL_AUTH_SECRET",
  "PLATFORM_ADMIN_EMAIL",
  "PLATFORM_ADMIN_PASSWORD",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "EASYPOST_API_KEY",
  "EASYPOST_WEBHOOK_SECRET",
  "GOOGLE_SOCIAL_LOGIN_CLIENT_ID",
  "GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET",
  "FACEBOOK_SOCIAL_LOGIN_CLIENT_ID",
  "FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET",
  "CATALOG_ASSET_S3_ACCESS_KEY_ID",
  "CATALOG_ASSET_S3_SECRET_ACCESS_KEY",
  "SES_AWS_ACCESS_KEY_ID",
  "SES_AWS_SECRET_ACCESS_KEY",
  "SES_SOURCE_ARN",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE",
  "SCRYDEX_API_KEY",
  "SCRYDEX_TEAM_ID",
  "CHASE_SETS_DISCORD_INVITE_URL",
]);

const envValueDefaults = {
  NODE_ENV: "production",
  PORT: "8080",
  DEPLOYMENT_ENVIRONMENT: "preview",
  CHASE_SETS_RUNTIME_PROFILE: "public",
  READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED: "false",
  READ_CONSISTENCY_READINESS_NOTIFICATIONS_ENABLED: "false",
  PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED: "false",
  PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS: "*",
  DATABASE_POOL_IDLE_TIMEOUT_MS: "5000",
  DATABASE_POOL_CONNECTION_TIMEOUT_MS: "10000",
  CHASE_SETS_TRUST_FORWARDED_HEADERS: "true",
  CHASE_SETS_PUBLIC_INDEXING: "false",
  CHASE_SETS_MARKETPLACE_INDEXING: "false",
  CHASE_SETS_CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE: "false",
  CHASE_SETS_RATE_LIMIT_AUTH_REGISTER_IP_MAX: "30",
  ADMIN_REGISTRATION_ENABLED: "false",
  REALTIME_BACKGROUND_MAINTENANCE_ENABLED: "false",
  REALTIME_WAKE_SIGNAL_ENABLED: "false",
  CATALOG_ASSET_STORAGE_KIND: "s3",
  CATALOG_ASSET_S3_BUCKET: "",
  CATALOG_ASSET_S3_REGION: "nyc3",
  CATALOG_ASSET_S3_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
  CATALOG_ASSET_PUBLIC_BASE_URL: "",
  TAX_PROVIDER_BACKED_QUOTES_REQUIRED: "false",
  OBSERVABILITY_ENABLED: "false",
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  OTEL_RESOURCE_ATTRIBUTES: "cloud.provider=digitalocean,cloud.platform=kubernetes,chase_sets.environment_slug=preview",
  STRIPE_CONNECT_ACCOUNTS_API: "v2",
  STRIPE_API_BASE_URL: "https://api.stripe.com",
  EASYPOST_API_BASE_URL: "https://api.easypost.com",
  EASYPOST_MODE: "test",
  ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS: "",
  REALTIME_STREAM_LIMITER: "postgres",
  NOTIFICATION_EMAIL_PROVIDER: "noop",
  SES_AWS_REGION: "",
  SES_FROM_EMAIL: "",
  SES_CONFIGURATION_SET_NAME: "",
  PLATFORM_ADMIN_DISPLAY_NAME: "Platform Admin",
  CHASE_SETS_PUBLIC_ORIGIN: "",
  CHASE_SETS_MARKETPLACE_ORIGIN: "",
  CHASE_SETS_INTERNAL_API_ORIGIN: "http://platform-api:8080",
  WORKER_MAX_CONCURRENT_RUNNERS: "5",
  WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS: "1",
  WORKER_JOB_MAX_CONCURRENT_RUNNERS: "1",
  WORKER_WAKE_MAX_CONCURRENT_RUNNERS: "2",
  WORKER_WAKE_HOT_LANE_RUNNER_COUNT: "1",
  WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT: "1",
  WORKER_WAKE_BULK_LANE_RUNNER_COUNT: "1",
  WORKER_WAKE_STATEMENT_TIMEOUT_MS: "30000",
  WORKER_PROJECTION_WAKE_RELAY_ENABLED: "false",
  SOURCE_OBSERVATION_BULK_JOB_LANE_COUNT: "1",
  SOURCE_OBSERVATION_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "1",
  SOURCE_OBSERVATION_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "1",
  CATALOG_AUTHORING_BULK_JOB_LANE_COUNT: "1",
  CATALOG_AUTHORING_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "1",
  CATALOG_AUTHORING_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "1",
  SOURCE_OBSERVATION_INTEGRATION_JOB_LANE_COUNT: "1",
  SOURCE_OBSERVATION_INTEGRATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "1",
  SOURCE_OBSERVATION_INTEGRATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "1",
  INVENTORY_IMPORT_BATCH_JOB_LANE_COUNT: "1",
  INVENTORY_IMPORT_BATCH_JOB_MAX_CONCURRENT_RUNNERS: "1",
  INVENTORY_IMPORT_BATCH_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "1",
  INVENTORY_IMPORT_BATCH_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "1",
  PRICING_RECOMMENDATION_JOB_LANE_COUNT: "1",
  PRICING_RECOMMENDATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "1",
  PRICING_RECOMMENDATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "1",
  SETTLEMENT_PAYOUT_RECONCILIATION_JOB_LANE_COUNT: "1",
  SETTLEMENT_PAYOUT_RECONCILIATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "1",
  SETTLEMENT_PAYOUT_RECONCILIATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "1",
  WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS: "1",
  WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS: "1",
  TCGPLAYER_AUTOMATION_REQUEST_DELAY_MS: "250",
  TCGPLAYER_AUTOMATION_RATE_LIMIT_COOLDOWN_MS: "30000",
  TCGPLAYER_AUTOMATION_MAX_CONCURRENT_REQUESTS: "2",
  TCGPLAYER_AUTOMATION_MAX_RETRIES: "3",
  CATALOG_INTEGRATION_CONTROL_PLANE_MODE: "open",
  CATALOG_INTEGRATION_ACTIVATION_MODE: "open",
  CATALOG_INTEGRATION_IMPORTS_DISABLED: "",
  CATALOG_INTEGRATION_PROMOTION_DISABLED: "",
  CATALOG_INTEGRATION_REAPPLY_DISABLED: "",
  CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP: "",
  CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES: "open",
};

const databasePoolMaxByComponent = {
  "platform-api": "6",
  "platform-worker": "7",
  "platform-bootstrap": "4",
};

const rolloutEligibleComponents = new Set(["public-web", "marketplace"]);

export function readPlatformSources(rootDir = repoRoot) {
  return {
    main: readFileSync(path.join(rootDir, platformMainRelativePath), "utf8"),
    locals: readFileSync(path.join(rootDir, platformLocalsRelativePath), "utf8"),
  };
}

export function extractDigitalOceanPlatformComponents(sources) {
  const locals = parsePlatformLocals(sources.locals);
  const platformResource = extractNamedBlock(sources.main, 'resource "digitalocean_app" "platform"');
  const spec = extractNamedBlock(platformResource, "spec");
  const terraformComponents = collectTopLevelComponents(spec).map((component) =>
    normalizeTerraformComponent(component, locals),
  );
  const byName = new Map(terraformComponents.map((component) => [component.name, component]));

  return componentOrder.map((name) => {
    const component = byName.get(name);
    if (!component) {
      throw new Error(`DigitalOcean platform component '${name}' is missing from ${platformMainRelativePath}.`);
    }
    return component;
  });
}

export function buildPlatformHelmValues(options = {}) {
  const sources = options.sources ?? readPlatformSources(options.repoRoot ?? repoRoot);
  const components = extractDigitalOceanPlatformComponents(sources);

  return {
    generatedBy,
    global: {
      nameOverride: "",
      fullnameOverride: "",
      image: {
        registry: "registry.digitalocean.com",
        registryName: "chase-sets",
        repository: "chase-sets-platform",
        tag: "latest",
        digest: "",
        pullPolicy: "IfNotPresent",
      },
      imagePullSecrets: [],
      envOverrides: {},
      existingSecretName: "chase-sets-platform-runtime",
      serviceAccount: {
        create: true,
        name: "",
      },
      rbac: {
        create: true,
      },
      podAnnotations: {},
      podLabels: {},
      nodeSelector: {},
      tolerations: [],
      affinity: {},
    },
    ingress: {
      enabled: false,
      className: "nginx",
      clusterIssuer: "",
      annotations: {},
      tls: {
        enabled: true,
        secretName: "chase-sets-platform-tls",
      },
      hosts: [],
    },
    components: Object.fromEntries(components.map((component) => [component.name, toHelmComponent(component)])),
  };
}

export function renderPlatformHelmValues(options = {}) {
  return `${renderYaml(buildPlatformHelmValues(options))}\n`
    .replace(
      `      activeDeadlineSeconds: ${bootstrapHookActiveDeadlineSeconds}\n`,
      [
        "      # Fail the hook inside Helm's 15m rollout timeout so atomic rollback sees a Kubernetes Job failure instead of a generic Helm condition timeout.",
        `      activeDeadlineSeconds: ${bootstrapHookActiveDeadlineSeconds}`,
      ].join("\n") + "\n",
    )
    .replace(
      `        timeoutSeconds: ${bootstrapQuiesceTimeoutSeconds}\n        commandTimeoutSeconds: ${bootstrapCommandTimeoutSeconds}\n`,
      [
        "        # Keep 45s drain + 780s bootstrap command + 5s kill grace + 45s restore below the hook deadline.",
        `        timeoutSeconds: ${bootstrapQuiesceTimeoutSeconds}`,
        `        commandTimeoutSeconds: ${bootstrapCommandTimeoutSeconds}`,
      ].join("\n") + "\n",
    );
}

export function syncPlatformHelmValues(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const outputPath = path.join(rootDir, chartValuesRelativePath);
  const content = renderPlatformHelmValues({ repoRoot: rootDir });

  if (options.check) {
    if (!existsSync(outputPath)) {
      throw new Error(`${normalizeRelative(outputPath, rootDir)} is missing`);
    }
    const currentContent = readFileSync(outputPath, "utf8");
    if (currentContent !== content) {
      throw new Error(`${normalizeRelative(outputPath, rootDir)} is stale; run ${generatedBy}`);
    }
    return { checked: true };
  }

  writeFileSync(outputPath, content, "utf8");
  return { checked: false };
}

function toHelmComponent(component) {
  const result = {
    enabled: true,
    kind: deploymentKindByTerraformKind[component.terraformKind],
    replicas: component.replicas,
    source: {
      digitalOceanKind: component.terraformKind,
      instanceCountExpression: component.instanceCountExpression,
    },
    command: component.command,
    env: component.env,
    resources: {},
    podAnnotations: {},
    podLabels: {},
  };

  if (component.port) {
    result.port = component.port;
    result.service = { type: "ClusterIP", port: component.port };
  }

  if (component.healthPath) {
    result.healthPath = component.healthPath;
  }

  if (rolloutEligibleComponents.has(component.name)) {
    result.rollout = {
      enabled: false,
      canary: {
        canaryServiceSuffix: "canary",
        trafficRouting: {
          nginx: {
            enabled: false,
            stableIngress: "",
          },
        },
        steps: [{ setWeight: 10 }, { pause: {} }],
      },
    };
  }

  if (component.terraformKind === "job") {
    result.job = {
      suspend: false,
      backoffLimit: 0,
      activeDeadlineSeconds: bootstrapHookActiveDeadlineSeconds,
      ttlSecondsAfterFinished: 600,
      hook: {
        enabled: true,
        events: ["pre-install", "pre-upgrade"],
        weight: -20,
        deletePolicy: ["before-hook-creation", "hook-succeeded"],
      },
      quiesce: {
        enabled: true,
        targetComponents: ["platform-worker"],
        timeoutSeconds: bootstrapQuiesceTimeoutSeconds,
        commandTimeoutSeconds: bootstrapCommandTimeoutSeconds,
        pollIntervalMs: 2000,
        restoreOnFailure: true,
        ignoreMissingDeployments: true,
      },
    };
  }

  return result;
}

function normalizeTerraformComponent(component, locals) {
  const env = collectComponentEnv(component.block, component.name, locals);

  return {
    name: component.name,
    terraformKind: component.kind,
    command: requiredStringAttribute(component.block, "run_command", component.name),
    instanceCountExpression: optionalAttributeExpression(component.block, "instance_count") ?? "1",
    replicas: defaultReplicaCount(component.name),
    port: optionalNumericAttribute(component.block, "http_port"),
    healthPath: optionalNestedStringAttribute(component.block, "health_check", "http_path"),
    env,
  };
}

function collectComponentEnv(block, componentName, locals) {
  const envByName = new Map();

  for (const envBlock of collectNamedBlocks(block, "env")) {
    const key = optionalStringAttribute(envBlock, "key");
    if (!key) {
      continue;
    }
    envByName.set(key, normalizeEnvEntry({ name: key, ...parseExplicitEnv(envBlock) }, componentName));
  }

  for (const dynamicBlock of collectDynamicEnvBlocks(block)) {
    for (const entry of expandDynamicEnv(dynamicBlock, locals)) {
      envByName.set(entry.name, normalizeEnvEntry(entry, componentName));
    }
  }

  return [...envByName.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function parseExplicitEnv(envBlock) {
  return {
    value: optionalStringAttribute(envBlock, "value"),
    secret: optionalStringAttribute(envBlock, "type") === "SECRET",
  };
}

function normalizeEnvEntry(entry, componentName) {
  const secret = Boolean(entry.secret || secretEnvFallbacks.has(entry.name) || entry.name.startsWith("DATABASE_URL_"));
  if (secret) {
    return {
      name: entry.name,
      secret: true,
      secretKey: entry.name,
    };
  }

  return {
    name: entry.name,
    value: envValue(entry, componentName),
  };
}

function envValue(entry, componentName) {
  if (entry.name === "DATABASE_POOL_MAX") {
    return databasePoolMaxByComponent[componentName] ?? envValueDefaults[entry.name] ?? "";
  }

  if (Object.hasOwn(envValueDefaults, entry.name)) {
    return envValueDefaults[entry.name];
  }

  if (entry.value != null && !entry.value.includes("${")) {
    return entry.value;
  }

  return "";
}

function expandDynamicEnv(dynamicBlock, locals) {
  const forEachExpression = optionalAttributeExpression(dynamicBlock, "for_each");

  if (forEachExpression === "local.observability_runtime_env") {
    return locals.observabilityRuntimeEnv;
  }

  if (forEachExpression === "local.catalog_provider_runtime_env") {
    return locals.catalogProviderRuntimeEnv;
  }

  if (forEachExpression === "local.rate_limit_runtime_env") {
    return locals.rateLimitRuntimeEnv;
  }

  if (forEachExpression === "local.context_database_env") {
    return locals.contextDatabaseEnv.map((name) => ({ name, secret: true }));
  }

  if (forEachExpression === "local.api_waiter_database_urls") {
    return locals.contextWaiterDatabaseEnv.map((name) => ({ name, secret: true }));
  }

  if (forEachExpression === "local.worker_listener_database_urls") {
    return locals.workerListenerDatabaseEnv.map((name) => ({ name, secret: true }));
  }

  throw new Error(`Unsupported dynamic platform env source '${forEachExpression}'.`);
}

function parsePlatformLocals(localsSource) {
  const platformContextNames = extractQuotedListLocal(localsSource, "platform_context_names");
  const apiWaiterContexts = extractQuotedListLocal(localsSource, "api_waiter_contexts");
  const workerListenerSourceContexts = extractQuotedListLocal(localsSource, "worker_listener_source_contexts");

  return {
    platformContextNames,
    apiWaiterContexts,
    workerListenerSourceContexts,
    observabilityRuntimeEnv: extractEnvMapLocal(localsSource, "observability_runtime_env"),
    catalogProviderRuntimeEnv: extractEnvMapLocal(localsSource, "catalog_provider_runtime_env"),
    rateLimitRuntimeEnv: extractEnvMapLocal(localsSource, "rate_limit_runtime_env"),
    contextDatabaseEnv: platformContextNames
      .filter((contextName) => contextName !== "control")
      .map((contextName) => `DATABASE_URL_${envToken(contextName)}`),
    contextWaiterDatabaseEnv: apiWaiterContexts.map((contextName) => `DATABASE_URL_${envToken(contextName)}_WAITER`),
    workerListenerDatabaseEnv: workerListenerSourceContexts.map(
      (contextName) => `WORKER_LISTENER_DATABASE_URL_${envToken(contextName)}`,
    ),
  };
}

function extractEnvMapLocal(source, localName) {
  const assignmentIndex = source.indexOf(`${localName} =`);
  if (assignmentIndex === -1) {
    throw new Error(`local.${localName} is missing from ${platformLocalsRelativePath}.`);
  }

  const block = extractBlockAt(source, source.indexOf("{", assignmentIndex));
  const keys = [];
  let index = 0;

  while (index < block.content.length) {
    const match = /([A-Z][A-Z0-9_]*)\s*=\s*\{/g.exec(block.content.slice(index));
    if (!match) {
      break;
    }
    const keyIndex = index + match.index;
    if (braceDepth(block.content.slice(0, keyIndex)) !== 0) {
      index = keyIndex + match[0].length;
      continue;
    }

    const entryBlock = extractBlockAt(block.content, keyIndex + match[0].lastIndexOf("{"));
    keys.push({
      name: match[1],
      secret: /secret\s*=\s*true/.test(entryBlock.content),
      value: optionalStringAttribute(entryBlock.content, "value"),
    });
    index = entryBlock.end;
  }

  return keys.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function extractQuotedListLocal(source, localName) {
  const assignmentMatch = new RegExp(`${localName}\\s*=\\s*\\[`).exec(source);
  const assignmentIndex = assignmentMatch?.index ?? -1;
  if (assignmentIndex === -1) {
    throw new Error(`local.${localName} is missing from ${platformLocalsRelativePath}.`);
  }

  const start = source.indexOf("[", assignmentIndex);
  const end = source.indexOf("]", start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function collectTopLevelComponents(spec) {
  const components = [];
  let index = 0;

  while (index < spec.length) {
    const match = /(dynamic\s+"service"\s*\{|service\s*\{|worker\s*\{|job\s*\{|ingress\s*\{)/g.exec(spec.slice(index));
    if (!match) {
      break;
    }

    const absoluteIndex = index + match.index;
    if (braceDepth(spec.slice(0, absoluteIndex)) !== 0) {
      index = absoluteIndex + match[0].length;
      continue;
    }

    if (match[0].startsWith("ingress")) {
      break;
    }

    const kind = match[0].startsWith("worker") ? "worker" : match[0].startsWith("job") ? "job" : "service";
    const block = extractBlockAt(spec, absoluteIndex + match[0].lastIndexOf("{"));
    const componentBlock = match[0].startsWith("dynamic") ? extractNamedBlock(block.content, "content") : block.content;
    const name = requiredStringAttribute(componentBlock, "name", kind);
    components.push({ name, kind, block: componentBlock });
    index = block.end;
  }

  return components;
}

function collectNamedBlocks(source, blockName) {
  const blocks = [];
  let index = 0;

  while (index < source.length) {
    const match = new RegExp(`${blockName}\\s*\\{`, "g").exec(source.slice(index));
    if (!match) {
      break;
    }

    const absoluteIndex = index + match.index;
    const block = extractBlockAt(source, absoluteIndex + match[0].lastIndexOf("{"));
    blocks.push(block.content);
    index = block.end;
  }

  return blocks;
}

function collectDynamicEnvBlocks(source) {
  const blocks = [];
  let index = 0;

  while (index < source.length) {
    const match = /dynamic\s+"env"\s*\{/g.exec(source.slice(index));
    if (!match) {
      break;
    }

    const absoluteIndex = index + match.index;
    const block = extractBlockAt(source, absoluteIndex + match[0].lastIndexOf("{"));
    blocks.push(block.content);
    index = block.end;
  }

  return blocks;
}

function extractNamedBlock(source, name) {
  const index = source.indexOf(`${name} {`);
  if (index === -1) {
    throw new Error(`Block '${name}' is missing.`);
  }

  return extractBlockAt(source, source.indexOf("{", index)).content;
}

function extractBlockAt(source, openBraceIndex) {
  if (source[openBraceIndex] !== "{") {
    throw new Error("Expected block to start at an opening brace.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          content: source.slice(openBraceIndex + 1, index),
          end: index + 1,
        };
      }
    }
  }

  throw new Error("Unclosed block.");
}

function braceDepth(source) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of source) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    }
  }

  return depth;
}

function requiredStringAttribute(source, name, owner) {
  const value = optionalStringAttribute(source, name);
  if (value == null) {
    throw new Error(`${owner} is missing required string attribute '${name}'.`);
  }
  return value;
}

function optionalStringAttribute(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(source);
  return match?.[1] ?? null;
}

function optionalAttributeExpression(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*([^\\n]+)`).exec(source);
  return match?.[1]?.trim() ?? null;
}

function optionalNumericAttribute(source, name) {
  const expression = optionalAttributeExpression(source, name);
  return expression && /^\d+$/.test(expression) ? Number(expression) : null;
}

function optionalNestedStringAttribute(source, blockName, attributeName) {
  const blocks = collectNamedBlocks(source, blockName);
  return blocks.length > 0 ? optionalStringAttribute(blocks[0], attributeName) : null;
}

function defaultReplicaCount(componentName) {
  if (componentName === "platform-bootstrap") {
    return 1;
  }
  return 1;
}

function envToken(contextName) {
  return contextName.replaceAll("-", "_").toUpperCase();
}

export function renderYaml(value, indent = 0) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return value
      .map((entry) => {
        if (isPlainObject(entry)) {
          const rendered = renderYaml(entry, indent + 2);
          const [firstLine, ...rest] = rendered.split("\n");
          return `${" ".repeat(indent)}- ${firstLine.trimStart()}${rest.length > 0 ? `\n${rest.join("\n")}` : ""}`;
        }
        return `${" ".repeat(indent)}- ${yamlScalar(entry)}`;
      })
      .join("\n");
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    return entries
      .map(([key, entry]) => {
        if (Array.isArray(entry)) {
          if (entry.length === 0) {
            return `${" ".repeat(indent)}${key}: []`;
          }
          return `${" ".repeat(indent)}${key}:\n${renderYaml(entry, indent + 2)}`;
        }
        if (isPlainObject(entry)) {
          if (Object.keys(entry).length === 0) {
            return `${" ".repeat(indent)}${key}: {}`;
          }
          return `${" ".repeat(indent)}${key}:\n${renderYaml(entry, indent + 2)}`;
        }
        return `${" ".repeat(indent)}${key}: ${yamlScalar(entry)}`;
      })
      .join("\n");
  }

  return yamlScalar(value);
}

function yamlScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }

  return JSON.stringify(String(value));
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(args) {
  if (args.length === 0) {
    return { check: false };
  }

  if (args.length === 1 && args[0] === "--check") {
    return { check: true };
  }

  throw new Error(`Usage: ${generatedBy} [--check]`);
}

function main() {
  const result = syncPlatformHelmValues(parseArgs(process.argv.slice(2)));
  console.log(result.checked ? "Platform Helm values are current." : "Platform Helm values generated.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
