import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  rebuildAllContextProjectionGroups,
  rebuildContextProjectionGroup,
  refreshProjectionGroupStatuses,
  summarizeProjectionReplayStatuses,
  type ContextProjectionGroupStatus,
  type ContextProjectionGroup,
} from "@chase-sets/bounded-context-runtime";
import { type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { listProjectionReplayTargets, rebuildProjectionSelection } from "./replay-projection-selection.ts";

type RuntimeShape = Readonly<{
  projectionGroups: readonly ContextProjectionGroup[];
}>;

type RuntimeHandle = Readonly<{
  runtime: RuntimeShape;
  pools: Readonly<Record<string, PgTransactionalPool>>;
}>;

type BenchmarkArgs = Readonly<{
  contextName?: string;
  out?: string;
  requiredOnly: boolean;
}>;

type ProjectionRebuildBenchmarkContext = Readonly<{
  contextName: string;
  projectionGroupCount: number;
  startedAt: string;
  completedAt: string;
  wallTimeMs: number;
  estimatedSourceEventsScanned: string;
  estimatedEventsPerSecond: number | null;
  preRebuild: ReturnType<typeof summarizeProjectionReplayStatuses>;
  postRebuild: ReturnType<typeof summarizeProjectionReplayStatuses>;
}>;

type ProjectionRebuildBenchmarkArtifact = Readonly<{
  schemaVersion: "projection-rebuild-benchmark/v1";
  generatedAt: string;
  deployable: string;
  contextName: string | null;
  requiredOnly: boolean;
  totals: Readonly<{
    contextCount: number;
    projectionGroupCount: number;
    wallTimeMs: number;
    estimatedSourceEventsScanned: string;
    estimatedEventsPerSecond: number | null;
  }>;
  contexts: readonly ProjectionRebuildBenchmarkContext[];
  postRebuild: ReturnType<typeof summarizeProjectionReplayStatuses>;
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
    import("@chase-sets/payment-processing/test-support"),
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
      "  pnpm run replay:projection -- <deployable> status [contextName]",
      "  pnpm run replay:projection -- <deployable> rebuild <contextName> <projectionName|--all>",
      "  pnpm run replay:projection -- <deployable> benchmark [contextName|--all] [--required-only] [--out <path>]",
      "",
      `Deployables: ${Object.keys(deployableLoaders).join(", ")}`,
    ].join("\n"),
  );
}

async function closePools(pools: Readonly<Record<string, PgTransactionalPool>>): Promise<void> {
  const uniquePools = [...new Set(Object.values(pools))];
  await Promise.all(uniquePools.map((pool) => (pool as unknown as { end: () => Promise<void> }).end()));
}

async function printStatuses(deployableName: string, runtime: RuntimeShape, contextName?: string): Promise<void> {
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

function parseBenchmarkArgs(args: readonly string[]): BenchmarkArgs {
  let contextName: string | undefined;
  let out: string | undefined;
  let requiredOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if (value === "--required-only") {
      requiredOnly = true;
      continue;
    }

    if (value === "--out") {
      out = args[index + 1];
      index += 1;
      continue;
    }

    if (value?.startsWith("--out=")) {
      out = value.slice("--out=".length);
      continue;
    }

    if (!contextName) {
      contextName = value === "--all" ? undefined : value;
      continue;
    }

    throw new Error(`Unexpected benchmark argument "${value}".`);
  }

  return { contextName, out, requiredOnly };
}

function sumDecimalStrings(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
}

function estimateSourceEventsScanned(statuses: readonly ContextProjectionGroupStatus[]): string {
  return sumDecimalStrings(
    statuses.flatMap((status) =>
      status.subscriptions.map((subscription) => subscription.sourceHeadGlobalPosition.toString()),
    ),
  );
}

function divideDecimalString(value: string, divisor: number): number | null {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && divisor > 0 ? numericValue / divisor : null;
}

async function writeJsonArtifact(out: string, artifact: ProjectionRebuildBenchmarkArtifact): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

async function benchmarkProjectionRebuilds(
  deployableName: string,
  runtime: RuntimeShape,
  args: BenchmarkArgs,
): Promise<ProjectionRebuildBenchmarkArtifact> {
  const targets = listProjectionReplayTargets(runtime)
    .filter((target) => !args.contextName || target.contextName === args.contextName)
    .map((target) => target.contextName);

  if (args.contextName && targets.length === 0) {
    const validContextNames = listProjectionReplayTargets(runtime).map((target) => target.contextName);
    throw new Error(`Unknown projection context "${args.contextName}". Use one of: ${validContextNames.join(", ")}.`);
  }

  const benchmarkStartedAt = performance.now();
  const contexts: ProjectionRebuildBenchmarkContext[] = [];

  for (const contextName of targets) {
    const preRebuildStatuses = await refreshProjectionGroupStatuses(runtime, {
      contextName,
      requiredOnly: args.requiredOnly,
    });
    const startedAt = new Date();
    const contextStartedAt = performance.now();

    await rebuildAllContextProjectionGroups(runtime, contextName, { requiredOnly: args.requiredOnly });

    const wallTimeMs = Math.round(performance.now() - contextStartedAt);
    const completedAt = new Date();
    const postRebuildStatuses = await refreshProjectionGroupStatuses(runtime, {
      contextName,
      requiredOnly: args.requiredOnly,
    });
    const estimatedSourceEventsScanned = estimateSourceEventsScanned(preRebuildStatuses);

    contexts.push({
      contextName,
      projectionGroupCount: preRebuildStatuses.length,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      wallTimeMs,
      estimatedSourceEventsScanned,
      estimatedEventsPerSecond: divideDecimalString(estimatedSourceEventsScanned, wallTimeMs / 1000),
      preRebuild: summarizeProjectionReplayStatuses(preRebuildStatuses),
      postRebuild: summarizeProjectionReplayStatuses(postRebuildStatuses),
    });
  }

  const totalWallTimeMs = Math.round(performance.now() - benchmarkStartedAt);
  const totalEstimatedSourceEventsScanned = sumDecimalStrings(
    contexts.map((context) => context.estimatedSourceEventsScanned),
  );
  const postRebuildStatuses = await refreshProjectionGroupStatuses(runtime, {
    contextName: args.contextName,
    requiredOnly: args.requiredOnly,
  });

  return {
    schemaVersion: "projection-rebuild-benchmark/v1",
    generatedAt: new Date().toISOString(),
    deployable: deployableName,
    contextName: args.contextName ?? null,
    requiredOnly: args.requiredOnly,
    totals: {
      contextCount: contexts.length,
      projectionGroupCount: contexts.reduce((total, context) => total + context.projectionGroupCount, 0),
      wallTimeMs: totalWallTimeMs,
      estimatedSourceEventsScanned: totalEstimatedSourceEventsScanned,
      estimatedEventsPerSecond: divideDecimalString(totalEstimatedSourceEventsScanned, totalWallTimeMs / 1000),
    },
    contexts,
    postRebuild: summarizeProjectionReplayStatuses(postRebuildStatuses),
  };
}

async function main(): Promise<void> {
  const [deployableName, action = "status", contextName, projectionName, ...remainingArgs] = process.argv.slice(2);

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

      await rebuildProjectionSelection(runtime, contextName, projectionName, {
        rebuildAllContextProjectionGroups,
        rebuildContextProjectionGroup,
      });

      await printStatuses(deployableName, runtime, contextName);
      return;
    }

    if (action === "benchmark") {
      const benchmarkArgs = parseBenchmarkArgs(
        [contextName, projectionName, ...remainingArgs].filter((value): value is string => Boolean(value)),
      );
      const artifact = await benchmarkProjectionRebuilds(deployableName, runtime, benchmarkArgs);

      if (artifact.contexts.length === 0) {
        throw new Error("No projection contexts matched the benchmark selection.");
      }

      console.log(JSON.stringify(artifact, null, 2));

      if (benchmarkArgs.out) {
        await writeJsonArtifact(benchmarkArgs.out, artifact);
      }

      return;
    }

    printUsage();
    process.exitCode = 1;
  } finally {
    await closePools(pools);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error) => {
    console.error("Projection replay command failed.", error);
    process.exit(1);
  });
}
