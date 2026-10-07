import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { repoRoot } from "./repo.mjs";
import { resolveWorktreeSandbox, getContextDatabaseEnvName } from "./sandbox.mjs";

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

export function browserE2ePostgresDemand({
  readSource = (file) => readFileSync(path.join(repoRoot, file), "utf8"),
} = {}) {
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
  const module = (file, dependencies) => {
    const exports = {};
    const compiled = ts.transpileModule(readSource(file), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: file,
    }).outputText;
    runInNewContext(compiled, {
      exports,
      URL,
      process: { env: {} },
      require(name) {
        if (!Object.hasOwn(dependencies, name)) throw new Error(`Unaccounted demand dependency: ${file}: ${name}`);
        return dependencies[name];
      },
    });
    return exports;
  };
  const registry = (kind) => {
    const file = `deployables/platform-${kind}/src/generated/${kind}-context-registry.ts`;
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
  };
  const apiContexts = registry("api");
  const workerContexts = registry("worker");
  const sandbox = resolveWorktreeSandbox({ env: {} });
  const postgresFactory = module("infrastructure/event-core-postgres/pool.ts", {
    "node:fs": { readFileSync },
    pg: {
      default: {
        Pool: function (options) {
          const row = createPgPool(options.connectionString, options);
          row.on = () => row;
          return row;
        },
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
    ["bounded-contexts/channels/support/seed-support/channel-publication-browser.ts", { process: "playwright" }],
    ["bounded-contexts/identity/support/seed-support/market-following-verification.ts", { process: "playwright" }],
  ]);
  const forwarded = new Set([
    apiPoolsPath,
    workerPoolsPath,
    contextPoolsPath,
    "infrastructure/event-core-postgres/pool.ts",
  ]);
  const dbTestOnly = new Set([
    "infrastructure/bounded-context-runtime/test-support.ts",
    "infrastructure/event-core-postgres/postgres-db-test-support.ts",
  ]);
  const inventoriedSources = new Set();
  for (const root of constructorRoots) {
    for (const absolute of sourceFiles(path.join(repoRoot, root))) {
      const file = path.relative(repoRoot, absolute).replaceAll("\\", "/");
      const source = readSource(file);
      if (!/createPgPool|new\s+(?:pg\.)?(?:Pool|Client)/.test(source)) continue;
      const found = constructors(file, source);
      if (found.length === 0 || forwarded.has(file) || dbTestOnly.has(file)) continue;
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
  add("dev-system", "provisioning", "owned SHOW psql client", 1, 1, "scripts/lib/sandbox.mjs");
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
