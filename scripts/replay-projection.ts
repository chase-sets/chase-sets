import process from "node:process";
import {
  rebuildAllContextProjectionGroups,
  rebuildContextProjectionGroup,
  refreshProjectionGroupStatuses,
  summarizeProjectionReplayStatuses,
  type ContextProjectionGroup,
} from "@chase-sets/bounded-context-runtime";
import {
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

async function loadPlatformApiRuntime(): Promise<RuntimeHandle> {
  const [
    { loadBootstrapConfig },
    { createPlatformApiHost },
    { createPlatformApiPools },
    { createFakePaymentProcessorGateway },
  ] = await Promise.all([
    import("../deployables/platform-api/src/config.ts"),
    import("../deployables/platform-api/src/app.ts"),
    import("../deployables/platform-api/src/database-pools.ts"),
    import("../infrastructure/payment-processing-testing/index.ts"),
  ]);
  const config = loadBootstrapConfig();
  const pools = createPlatformApiPools(config);

  return {
    pools,
    runtime: createPlatformApiHost({
      pools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
      },
    }),
  };
}

const deployableLoaders: Record<string, DeployableLoader> = {
  "platform-api": loadPlatformApiRuntime,
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
  const uniquePools = [...new Set(Object.values(pools))];
  await Promise.all(
    uniquePools.map((pool) =>
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
