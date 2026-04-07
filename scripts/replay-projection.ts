import process from "node:process";
import {
  rebuildAllContextProjectionGroups,
  rebuildContextProjectionGroup,
  refreshProjectionGroupStatuses,
  summarizeProjectionReplayStatuses,
  type ContextProjectionGroup,
} from "@chase-sets/bounded-context-runtime";
import {
  createPgPool,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";

type RuntimeShape = Readonly<{
  projectionGroups: readonly ContextProjectionGroup[];
}>;

type RuntimeHandle = Readonly<{
  runtime: RuntimeShape;
  pools: Readonly<Record<string, PgTransactionalPool>>;
}>;

type DeployableLoader = () => Promise<RuntimeHandle>;

function createPools<TDatabaseUrls extends Record<string, string>>(
  databaseUrls: TDatabaseUrls,
): { [K in keyof TDatabaseUrls]: PgTransactionalPool } {
  return Object.fromEntries(
    Object.entries(databaseUrls).map(([contextName, databaseUrl]) => [
      contextName,
      createPgPool(databaseUrl),
    ]),
  ) as { [K in keyof TDatabaseUrls]: PgTransactionalPool };
}

async function loadCatalogApiRuntime(): Promise<RuntimeHandle> {
  const [{ loadConfig }, { createContextRuntime }] = await Promise.all([
    import("../deployables/catalog-api/src/config.ts"),
    import("../deployables/catalog-api/src/context-runtime.generated.ts"),
  ]);
  const config = loadConfig();
  const pools = createPools(config.databaseUrls);

  return {
    pools,
    runtime: createContextRuntime(pools),
  };
}

async function loadIdentityApiRuntime(): Promise<RuntimeHandle> {
  const [{ loadConfig }, { createContextRuntime }] = await Promise.all([
    import("../deployables/identity-api/src/config.ts"),
    import("../deployables/identity-api/src/context-runtime.generated.ts"),
  ]);
  const config = loadConfig();
  const pools = createPools(config.databaseUrls);

  return {
    pools,
    runtime: createContextRuntime(pools),
  };
}

async function loadInventoryApiRuntime(): Promise<RuntimeHandle> {
  const [{ loadConfig }, { createContextRuntime }] = await Promise.all([
    import("../deployables/inventory-api/src/config.ts"),
    import("../deployables/inventory-api/src/context-runtime.generated.ts"),
  ]);
  const config = loadConfig();
  const pools = createPools(config.databaseUrls);

  return {
    pools,
    runtime: createContextRuntime(pools),
  };
}

async function loadMarketplaceApiRuntime(): Promise<RuntimeHandle> {
  const [
    { loadBootstrapConfig },
    { createContextRuntime },
    { createFakePaymentProcessorGateway },
  ] = await Promise.all([
    import("../deployables/marketplace-api/src/config.ts"),
    import("../deployables/marketplace-api/src/context-runtime.generated.ts"),
    import("../deployables/marketplace-api/src/payment-processor.ts"),
  ]);
  const config = loadBootstrapConfig();
  const pools = createPools(config.databaseUrls);

  return {
    pools,
    runtime: createContextRuntime(pools, {
      processorGateway: createFakePaymentProcessorGateway(),
    }),
  };
}

const deployableLoaders: Record<string, DeployableLoader> = {
  "catalog-api": loadCatalogApiRuntime,
  "identity-api": loadIdentityApiRuntime,
  "inventory-api": loadInventoryApiRuntime,
  "marketplace-api": loadMarketplaceApiRuntime,
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npm run replay:projection -- <deployable> status [contextName]",
      "  npm run replay:projection -- <deployable> rebuild <contextName> <projectionName|--all>",
      "",
      `Deployables: ${Object.keys(deployableLoaders).join(", ")}`,
    ].join("\n"),
  );
}

async function closePools(pools: Readonly<Record<string, PgTransactionalPool>>): Promise<void> {
  await Promise.all(
    Object.values(pools).map((pool) =>
      (pool as unknown as { end: () => Promise<void> }).end(),
    ),
  );
}

async function printStatuses(
  deployableName: string,
  runtime: RuntimeShape,
  contextName?: string,
): Promise<void> {
  const groups = await refreshProjectionGroupStatuses(runtime, { contextName });
  const summary = summarizeProjectionReplayStatuses(groups);

  console.log(
    JSON.stringify(
      {
        deployable: deployableName,
        contextName: contextName ?? null,
        summary,
        groups,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const [deployableName, action = "status", contextName, projectionName] =
    process.argv.slice(2);

  if (!deployableName || !(deployableName in deployableLoaders)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const loadRuntime = deployableLoaders[deployableName];
  const { runtime, pools } = await loadRuntime();

  try {
    if (action === "status") {
      await printStatuses(deployableName, runtime, contextName);
      return;
    }

    if (action === "rebuild") {
      if (!contextName || !projectionName) {
        printUsage();
        process.exitCode = 1;
        return;
      }

      if (projectionName === "--all") {
        await rebuildAllContextProjectionGroups(runtime, contextName);
      } else {
        await rebuildContextProjectionGroup(runtime, contextName, projectionName);
      }

      await printStatuses(deployableName, runtime, contextName);
      return;
    }

    printUsage();
    process.exitCode = 1;
  } finally {
    await closePools(pools);
  }
}

void main().catch((error) => {
  console.error("Projection replay command failed.", error);
  process.exit(1);
});
