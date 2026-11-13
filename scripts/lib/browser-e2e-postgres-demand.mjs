import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { repoRoot } from "./repo.mjs";
import { resolveWorktreeSandbox, getContextDatabaseEnvName } from "./sandbox.mjs";
import { buildPreviewPostgresConnectionSnapshotCommands } from "../platform-kubernetes-deployment.mjs";
import { buildPlatformSecretBundle, collectPlatformSecretKeys } from "../platform-kubernetes-secret.mjs";
import { isDatabaseSecretKey, runtimeValuesRelativePath } from "../render-platform-helm-values.mjs";

const apiPoolsPath = "deployables/platform-api/src/database-pools.ts";
const workerPoolsPath = "deployables/platform-worker/src/database-pools.ts";
const contextPoolsPath = "infrastructure/platform-runtime/context-pools.ts";
const constructorRoots = [
  "deployables/platform-api/src",
  "deployables/platform-worker/src",
  "deployables/marketplace",
  "deployables/admin-web",
  "infrastructure",
  "bounded-contexts",
  "contracts",
  "packages",
];
// Pool factories the derivations invoke directly, and DB-test-only constructors.
const forwardedClientSources = new Set([
  apiPoolsPath,
  workerPoolsPath,
  contextPoolsPath,
  "infrastructure/event-core-postgres/pool.ts",
]);
const dbTestOnlyClientSources = new Set([
  "infrastructure/bounded-context-runtime/test-support.ts",
  "infrastructure/event-core-postgres/postgres-db-test-support.ts",
]);
const playwrightClientSources = [
  "bounded-contexts/channels/support/seed-support/channel-publication-browser.ts",
  "bounded-contexts/identity/support/seed-support/market-following-verification.ts",
];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "build", "dist", "tests", "__tests__", ".react-router"].includes(entry.name)) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : /\.(?:ts|tsx)$/.test(file) && !/\.(?:test|db\.test)\./.test(file)
        ? [file]
        : [];
  });
}

function constructors(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(node) {
    if (
      (ts.isCallExpression(node) && node.expression.getText(tree) === "createPgPool") ||
      (ts.isNewExpression(node) && /^(?:pg\.)?(?:Pool|Client)$/.test(node.expression.getText(tree)))
    ) {
      result.push({ node, tree, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result;
}

function literalMaximum(constructor) {
  const options = constructor.node.arguments?.[ts.isNewExpression(constructor.node) ? 0 : 1];
  if (!options || !ts.isObjectLiteralExpression(options)) throw new Error("Pool options must be explicit.");
  const maximum = options.properties.findLast(
    (property) => ts.isPropertyAssignment(property) && property.name.getText(constructor.tree) === "max",
  )?.initializer;
  if (!maximum || !ts.isNumericLiteral(maximum)) throw new Error("Pool maximum must be a positive literal.");
  return positiveInteger(Number(maximum.text));
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Missing or invalid pool maximum: ${value}`);
  return value;
}

const defaultReadSource = (file) => readFileSync(path.join(repoRoot, file), "utf8");

// Runs a real TypeScript source in isolation; `env` is the module's live process.env.
function loadSourceModule(readSource, file, dependencies, env = {}) {
  const exports = {};
  const compiled = ts.transpileModule(readSource(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  runInNewContext(compiled, {
    exports,
    URL,
    process: { env },
    require(name) {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unaccounted demand dependency: ${file}: ${name}`);
      return dependencies[name];
    },
  });
  return exports;
}

function contextRegistry(readSource, kind) {
  const file = `deployables/platform-${kind}/src/context-registry.ts`;
  const source = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true);
  const names = [];
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "contextName" &&
      ts.isStringLiteral(node.initializer)
    ) {
      names.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (names.length === 0 || new Set(names).size !== names.length)
    throw new Error(`Missing or duplicate registry: ${file}`);
  return names;
}

function* clientConstructorSources(readSource) {
  for (const root of constructorRoots) {
    for (const absolute of sourceFiles(path.join(repoRoot, root))) {
      const file = path.relative(repoRoot, absolute).replaceAll("\\", "/");
      const source = readSource(file);
      if (!/createPgPool|new\s+(?:pg\.)?(?:Pool|Client)/.test(source)) continue;
      const found = constructors(file, source);
      if (found.length > 0) yield { file, found };
    }
  }
}

export function browserE2ePostgresDemand({ readSource = defaultReadSource } = {}) {
  const inventory = [];
  let processName;
  let phase;
  const createPgPool = (url, options) => {
    const row = {
      process: processName,
      phase,
      pool: new URL(url).pathname.slice(1),
      max: positiveInteger(options?.max),
    };
    inventory.push(row);
    return row;
  };
  const module = (file, dependencies) => loadSourceModule(readSource, file, dependencies);
  const apiContexts = contextRegistry(readSource, "api");
  const workerContexts = contextRegistry(readSource, "worker");
  const sandbox = resolveWorktreeSandbox({ env: {} });
  const postgresFactory = module("infrastructure/event-core-postgres/pool.ts", {
    "node:fs": { readFileSync },
    pg: {
      Pool: function (options) {
        const row = createPgPool(options.connectionString, options);
        row.on = () => row;
        return row;
      },
    },
  });
  const contextPools = module(contextPoolsPath, { "@chase-sets/event-core-postgres": postgresFactory });
  const api = module(apiPoolsPath, {
    "@chase-sets/platform-runtime/context-pools": contextPools,
    "@chase-sets/event-core-postgres": postgresFactory,
    "./config": { getContextDatabaseEnvName, getPlatformApiContextsForRuntimeProfile: () => apiContexts },
  });
  const worker = module(workerPoolsPath, {
    "@chase-sets/platform-runtime/context-pools": contextPools,
    "@chase-sets/event-core-postgres": postgresFactory,
    "./config": { getContextDatabaseEnvName, getPlatformWorkerContextsForRuntimeProfile: () => workerContexts },
  });
  const config = (kind) => {
    const env = readSource(`deployables/platform-${kind}/.env.example`);
    const maximum = positiveInteger(Number(/^DATABASE_POOL_MAX=(\d+)\r?$/m.exec(env)?.[1]));
    for (const name of kind === "api" ? apiContexts : workerContexts) {
      if (!sandbox.contextDatabaseUrls[name]) throw new Error(`Missing sandbox database for ${kind}/${name}`);
    }
    return {
      contextDatabaseUrls: sandbox.contextDatabaseUrls,
      controlDatabaseUrl: sandbox.controlDatabaseUrl,
      workSignalDatabaseUrl: sandbox.controlDatabaseUrl,
      pool: { max: maximum },
    };
  };
  phase = "runtime/test/teardown";
  processName = "platform-api";
  const apiRegistry = api.createPlatformApiPools(config("api"));
  processName = "platform-worker";
  const workerRegistry = worker.createPlatformWorkerPools(config("worker"));
  worker.createSettlementBootstrapPool(config("worker"));
  phase = "bootstrap";
  processName = "api-bootstrap";
  api.createSeedCommandPools(config("api"));
  processName = "worker-bootstrap";
  worker.createPlatformWorkerPools(config("worker"));

  const add = (process, phase, pool, max, copies = 1, source = null) => {
    for (let index = 0; index < copies; index++)
      inventory.push({ process, phase, pool: `${pool}/${index + 1}`, max, source });
  };
  const supplemental = new Map([
    ["deployables/platform-api/src/preview-postgres.ts", { process: "api-bootstrap", phase: "bootstrap" }],
    ["deployables/platform-worker/src/main.ts", { process: "platform-worker", copies: workerContexts.length }],
    [
      "infrastructure/platform-runtime/post-write-token-store.ts",
      { process: "api/marketplace/admin token stores", copies: 3 },
    ],
    ...playwrightClientSources.map((file) => [file, { process: "playwright" }]),
  ]);
  const inventoriedSources = new Set();
  for (const { file, found } of clientConstructorSources(readSource)) {
    if (forwardedClientSources.has(file) || dbTestOnlyClientSources.has(file)) continue;
    const holder = supplemental.get(file) ?? (file.includes("/e2e/") ? { process: "playwright" } : null);
    if (!holder) throw new Error(`Unaccounted browser E2E client constructor: ${file}:${found[0].line}`);
    inventoriedSources.add(file);
    for (const constructor of found) {
      if (file === "infrastructure/platform-runtime/post-write-token-store.ts") {
        const tokenModule = module(file, {
          "node:crypto": {
            randomBytes: () => {
              throw new Error("Unexpected token allocation.");
            },
          },
          "@chase-sets/http/responses": {},
          "@chase-sets/event-core-postgres": postgresFactory,
        });
        phase = "runtime/test/teardown";
        for (const [name, maximum] of [
          ["platform-api tokens", config("api").pool.max],
          ["marketplace tokens", null],
          ["admin tokens", null],
        ]) {
          processName = name;
          tokenModule.resetDefaultPostWriteTokenStoreForTests();
          tokenModule.getDefaultPostWriteTokenStore({
            PLATFORM_CONTROL_DATABASE_URL: sandbox.controlDatabaseUrl,
            ...(maximum ? { DATABASE_POOL_MAX: String(maximum) } : {}),
          });
        }
      } else {
        add(
          holder.process,
          holder.phase ?? "runtime/test/teardown",
          file,
          literalMaximum(constructor),
          holder.copies,
          `${file}:${constructor.line}`,
        );
      }
    }
  }
  for (const file of supplemental.keys()) {
    if (!inventoriedSources.has(file)) throw new Error(`Missing browser E2E client source: ${file}`);
  }
  const launcher = readSource("scripts/dev-system.mjs");
  const readiness = readSource("scripts/browser-e2e-readiness.mjs");
  const apiBootstrap = readSource("deployables/platform-api/src/bootstrap.ts");
  const workerBootstrap = readSource("deployables/platform-worker/src/bootstrap.ts");
  if (
    !launcher.includes("await runBootstrap(targetName, lifecycleRecorder)") ||
    !launcher.includes("await pool.end()") ||
    !apiBootstrap.includes('await runBootstrapPhase("close-database-pools", () => closePlatformApiPools(pools))') ||
    !workerBootstrap.includes("await closePlatformWorkerPools(pools)")
  ) {
    throw new Error("Bootstrap exclusion requires awaited bootstrap and pool shutdown.");
  }
  if (
    constructors("scripts/dev-system.mjs", launcher).length !== 1 ||
    constructors("scripts/browser-e2e-readiness.mjs", readiness).length !== 3
  ) {
    throw new Error("Re-inventory launcher/readiness client holdings.");
  }
  const require = createRequire(import.meta.url);
  const pgPoolSource = readFileSync(createRequire(require.resolve("pg")).resolve("pg-pool"), "utf8");
  const defaultMaximum = positiveInteger(Number(/this\.options\.max\s*=.*?\|\|\s*(\d+)/.exec(pgPoolSource)?.[1]));
  add("dev-system", "provisioning", "admin pool", defaultMaximum, 1, "scripts/dev-system.mjs");
  add("dev-system", "provisioning", "owned SHOW psql client", 1, 1, "scripts/dev-system-config.mjs");
  add("dev-system", "priming", "control + sequential context clients", 1, 2, "scripts/browser-e2e-readiness.mjs");
  add("readiness", "all phases", "sequential snapshot query/sample clients", 1, 2, "scripts/browser-e2e-readiness.mjs");
  const totals = (selectedPhase) =>
    inventory
      .filter((row) => row.phase === selectedPhase || row.phase === "all phases")
      .reduce((sum, row) => sum + row.max, 0);
  const phaseDemand = Object.fromEntries(
    ["provisioning", "bootstrap", "priming", "runtime/test/teardown"].map((value) => [value, totals(value)]),
  );
  return { inventory, phaseDemand, demand: Math.max(...Object.values(phaseDemand)), apiRegistry, workerRegistry };
}

// PostgreSQL 16 server defaults, in force for any setting the chart does not render.
const postgresDefaultSettings = { max_connections: 100, superuser_reserved_connections: 3, reserved_connections: 0 };
// Every DEPLOYMENT_ENVIRONMENT=preview release (PR, merge gate, ephemeral verification) shares this server shape.
const previewWorkflowPaths = [
  ".github/workflows/platform-pr.yml",
  ".github/workflows/platform-merge-gate-verification.yml",
  ".github/workflows/platform-ephemeral-verification.yml",
];
const previewProcesses = new Map([
  ["pnpm --filter @chase-sets/app-platform-api run start:production", "api"],
  ["pnpm --filter @chase-sets/app-platform-worker run start:production", "worker"],
  ["pnpm --filter @chase-sets/app-platform-api run bootstrap:production", "api-bootstrap"],
]);
// Commands a preview workflow `kubectl exec`s inside a runtime pod, mapped to that pod's component.
const previewInPodCommands = new Map([["representative-commerce-state:production", "platform-api"]]);
const tokenStorePath = "infrastructure/platform-runtime/post-write-token-store.ts";
const previewAdminPoolPath = "deployables/platform-api/src/preview-postgres.ts";
const relayListenerPath = "deployables/platform-worker/src/main.ts";
const previewDemandEnvNames = new Set(["DATABASE_POOL_MAX", "WORKER_PROJECTION_WAKE_RELAY_ENABLED"]);

export function previewPostgresSettings(previewPostgres) {
  return { ...postgresDefaultSettings, ...previewPostgres?.settings };
}

/**
 * Peak preview Postgres connections: the maximum over preview phases of every pool the
 * preview render enables, built by the real pool factories from each component's rendered env and
 * the real preview Secret. Aliased URLs dedupe only inside one process.
 */
export function previewPostgresDemand({ readSource = defaultReadSource } = {}) {
  const {
    schemaVersion: _schemaVersion,
    productionEnvOverrides: _productionEnvOverrides,
    ...values
  } = JSON.parse(readSource(runtimeValuesRelativePath));
  const workflows = previewWorkflowPaths.map((file) => ({ file, source: readSource(file) }));
  for (const { file, source } of workflows) {
    // Literal overrides, quoted or not, and names passed to the PR workflow's add_optional_runtime_env helper.
    for (const [, name] of source.matchAll(/(?:--runtime-env|add_optional_runtime_env)\s+"?([A-Za-z0-9_]+)[="\s]/g)) {
      if (previewDemandEnvNames.has(name) || isDatabaseSecretKey(name)) {
        throw new Error(`Preview deploy overrides a connection demand input: ${file}: ${name}`);
      }
    }
  }
  const envOverrides = { ...values.global?.envOverrides, DEPLOYMENT_ENVIRONMENT: "preview" };
  const secretKeys = collectPlatformSecretKeys(values, { deploymentEnvironment: "preview" });
  const { runtimeSecret } = buildPlatformSecretBundle({
    values,
    secretKeys,
    deploymentEnvironment: "preview",
    release: "chase-sets-pr-1",
    namespace: "chase-sets-pr-1",
    superuserPassword: "synthetic",
    applicationPassword: "synthetic",
    env: Object.fromEntries(secretKeys.filter((key) => !isDatabaseSecretKey(key)).map((key) => [key, "synthetic"])),
  });
  const secret = Object.fromEntries(
    Object.entries(runtimeSecret.data).map(([key, value]) => [key, Buffer.from(value, "base64").toString("utf8")]),
  );
  const renderedEnv = (name, component) =>
    Object.fromEntries(
      component.env.map((entry) => {
        if (!entry.secret) {
          return [entry.name, component.envOverrides?.[entry.name] ?? envOverrides[entry.name] ?? entry.value ?? ""];
        }
        if (entry.secretName && isDatabaseSecretKey(entry.secretKey ?? entry.name)) {
          throw new Error(`Preview database URL outside the runtime Secret: ${name}: ${entry.name}`);
        }
        return [entry.name, secret[entry.secretKey ?? entry.name]];
      }),
    );
  const components = Object.entries(values.components).flatMap(([name, component]) =>
    component.enabled ? [{ name, component, env: renderedEnv(name, component) }] : [],
  );

  const sources = new Map();
  for (const { file, found } of clientConstructorSources(readSource)) {
    if (dbTestOnlyClientSources.has(file) || playwrightClientSources.includes(file) || file.includes("/e2e/")) continue;
    if (
      !forwardedClientSources.has(file) &&
      ![tokenStorePath, previewAdminPoolPath, relayListenerPath].includes(file)
    ) {
      throw new Error(`Unaccounted preview Postgres client constructor: ${file}:${found[0].line}`);
    }
    sources.set(file, found);
  }
  for (const file of [...forwardedClientSources, tokenStorePath, previewAdminPoolPath, relayListenerPath]) {
    if (!sources.has(file)) throw new Error(`Missing preview Postgres client source: ${file}`);
  }
  for (const file of [tokenStorePath, previewAdminPoolPath, relayListenerPath]) {
    if (sources.get(file).length !== 1) throw new Error(`Re-inventory preview Postgres client holdings: ${file}`);
  }
  const at = (file, text) => {
    const line = readSource(file)
      .split(/\r?\n/)
      .findIndex((candidate) => candidate.includes(text));
    if (line === -1) throw new Error(`Missing preview pool factory: ${file}: ${text}`);
    return `${file}:${line + 1}`;
  };
  const constructedAt = (file) => `${file}:${sources.get(file)[0].line}`;

  const inventory = [];
  let holder;
  const createPgPool = (url, options) => {
    const parsed = new URL(url);
    const row = {
      ...holder,
      pool: `${decodeURIComponent(parsed.username)}@${decodeURIComponent(parsed.pathname.slice(1))}`,
      max: positiveInteger(options?.max),
    };
    inventory.push(row);
    return row;
  };
  const hold = (process, phase, source, reason, open) => {
    holder = { process, phase, source, reason };
    return open();
  };
  const processEnv = {};
  const useEnv = (env) => {
    for (const key of Object.keys(processEnv)) delete processEnv[key];
    Object.assign(processEnv, env);
  };
  const load = (file, dependencies) => loadSourceModule(readSource, file, dependencies, processEnv);
  const postgresFactory = load("infrastructure/event-core-postgres/pool.ts", {
    "node:fs": { readFileSync },
    pg: {
      Pool: function (options) {
        const row = createPgPool(options.connectionString, options);
        row.on = () => row;
        return row;
      },
    },
  });
  const configSchema = load("infrastructure/platform-runtime/config-schema.ts", {
    "@chase-sets/bounded-context-module": { ENVIRONMENT_DATA_PROFILES: [] },
  });
  const contextPools = load(contextPoolsPath, { "@chase-sets/event-core-postgres": postgresFactory });
  const apiContexts = contextRegistry(readSource, "api");
  const workerContexts = contextRegistry(readSource, "worker");
  const api = load(apiPoolsPath, {
    "@chase-sets/platform-runtime/context-pools": contextPools,
    "@chase-sets/event-core-postgres": postgresFactory,
    "./config": {
      getContextDatabaseEnvName: configSchema.getContextDatabaseEnvName,
      getPlatformApiContextsForRuntimeProfile: () => apiContexts,
    },
  });
  const worker = load(workerPoolsPath, {
    "@chase-sets/platform-runtime/context-pools": contextPools,
    "@chase-sets/event-core-postgres": postgresFactory,
    "./config": {
      getContextDatabaseEnvName: configSchema.getContextDatabaseEnvName,
      getPlatformWorkerContextsForRuntimeProfile: () => workerContexts,
    },
  });
  const tokenStore = load(tokenStorePath, {
    "node:crypto": {
      randomBytes: () => {
        throw new Error("Unexpected token allocation.");
      },
    },
    "@chase-sets/http/responses": {},
    "@chase-sets/event-core-postgres": postgresFactory,
  });
  // The real env parsing (loadPlatformDatabaseConfig/loadPoolConfig) over one component's rendered env.
  const configFor = (env, contextNames) => {
    useEnv(env);
    return {
      deploymentEnvironment: env.DEPLOYMENT_ENVIRONMENT,
      ...configSchema.loadPlatformDatabaseConfig({
        contextNames,
        missingControlDatabaseUrlError: "Preview render has no control database URL.",
      }),
      pool: configSchema.loadPoolConfig(),
    };
  };
  const workerConfigSource = readSource("deployables/platform-worker/src/config.ts");
  if (
    !workerConfigSource.includes('getBooleanEnv("WORKER_PROJECTION_WAKE_RELAY_ENABLED", true)') ||
    !workerConfigSource.includes("return `WORKER_LISTENER_DATABASE_URL_${")
  ) {
    throw new Error("Re-inventory the worker projection wake relay listener configuration.");
  }
  const apiPoolsAt = at(apiPoolsPath, "export function createPlatformApiPools(");
  const seedPoolsAt = at(apiPoolsPath, "export function createSeedCommandPools(");

  for (const { name, component, env } of components) {
    const kind = previewProcesses.get(component.command);
    if (kind === "api") {
      hold(name, "runtime", apiPoolsAt, "context + control pools", () =>
        api.createPlatformApiPools(configFor(env, apiContexts)),
      );
    } else if (kind === "worker") {
      const config = configFor(env, workerContexts);
      hold(
        name,
        "runtime",
        at(workerPoolsPath, "export function createPlatformWorkerPools("),
        "context + control pools",
        () => worker.createPlatformWorkerPools(config),
      );
      hold(name, "runtime", constructedAt(workerPoolsPath), "settlement schema bootstrap beside the worker pools", () =>
        worker.createSettlementBootstrapPool(config),
      );
      useEnv(env);
      if (configSchema.getBooleanEnv("WORKER_PROJECTION_WAKE_RELAY_ENABLED", true)) {
        for (const contextName of workerContexts) {
          const url = env[`WORKER_LISTENER_DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`];
          if (!url) continue;
          hold(name, "runtime", constructedAt(relayListenerPath), "projection wake relay listener", () =>
            createPgPool(url, { max: literalMaximum(sources.get(relayListenerPath)[0]) }),
          );
        }
      }
    } else if (kind === "api-bootstrap") {
      const hook = component.job?.hook;
      // A pre-install hook finishes before any runtime pod of the fresh preview release starts.
      const phase = hook?.enabled && hook.events.includes("pre-install") ? "bootstrap" : "runtime";
      if (env.PLATFORM_PREVIEW_POSTGRES_ADMIN_URL) {
        hold(name, phase, constructedAt(previewAdminPoolPath), "preview database/role provisioning (superuser)", () =>
          createPgPool(env.PLATFORM_PREVIEW_POSTGRES_ADMIN_URL, {
            max: literalMaximum(sources.get(previewAdminPoolPath)[0]),
          }),
        );
      }
      hold(name, phase, seedPoolsAt, "schema bootstrap + seed pools", () =>
        api.createSeedCommandPools(configFor(env, apiContexts)),
      );
    }
    if (component.kind === "service" && env.PLATFORM_CONTROL_DATABASE_URL) {
      tokenStore.resetDefaultPostWriteTokenStoreForTests();
      hold(name, "runtime", constructedAt(tokenStorePath), "default post-write token store", () =>
        tokenStore.getDefaultPostWriteTokenStore(env),
      );
    }
    const opensDatabase = Object.entries(env).some(
      ([key, value]) => value && (isDatabaseSecretKey(key) || key === "PLATFORM_PREVIEW_POSTGRES_ADMIN_URL"),
    );
    if (opensDatabase && !inventory.some((row) => row.process === name)) {
      throw new Error(`Unaccounted preview database consumer: ${name}`);
    }
    // Rows count one pod. Each preview workflow installs once into a reset namespace, so no
    // rolling-update or canary surge pod overlaps; more rendered pods would multiply every row.
    if (
      ["service", "worker"].includes(component.kind) &&
      inventory.some((row) => row.process === name) &&
      (component.replicas !== 1 || component.autoscaling?.enabled)
    ) {
      throw new Error(`Re-inventory preview replicas: ${name}`);
    }
  }

  const inPodCommands = new Set();
  for (const { file, source } of workflows) {
    const commands = [...source.matchAll(/--filter @chase-sets\/app-platform-api run (\S+)/g)].map(
      ([, script]) => script,
    );
    if (commands.length !== [...source.matchAll(/kubectl exec\b/g)].length) {
      throw new Error(`Re-inventory in-pod preview commands: ${file}`);
    }
    for (const script of commands) {
      if (!previewInPodCommands.has(script)) throw new Error(`Unaccounted in-pod preview command: ${file}: ${script}`);
      inPodCommands.add(script);
    }
  }
  for (const script of inPodCommands) {
    const target = components.find(({ name }) => name === previewInPodCommands.get(script));
    hold(
      `${target.name} exec ${script}`,
      "runtime",
      seedPoolsAt,
      "in-pod seed command beside the pod's own pools",
      () => api.createSeedCommandPools(configFor(target.env, apiContexts)),
    );
  }
  const snapshot = buildPreviewPostgresConnectionSnapshotCommands({
    namespace: "chase-sets-pr-1",
    release: "chase-sets-pr-1",
  });
  for (const [, args] of snapshot.filter(([, args]) => args.includes("psql"))) {
    hold(
      "preview-postgres snapshot",
      "runtime",
      "scripts/platform-kubernetes-deployment.mjs",
      "PR connection snapshot (superuser psql)",
      () =>
        createPgPool(
          `postgresql://${args[args.indexOf("--username") + 1]}@local/${args[args.indexOf("--dbname") + 1]}`,
          {
            max: 1,
          },
        ),
    );
  }

  const phaseDemand = Object.fromEntries(
    ["bootstrap", "runtime"].map((phase) => [
      phase,
      inventory.filter((row) => row.phase === phase).reduce((sum, row) => sum + row.max, 0),
    ]),
  );
  return {
    inventory,
    phaseDemand,
    demand: Math.max(...Object.values(phaseDemand)),
    settings: previewPostgresSettings(values.previewPostgres),
  };
}
