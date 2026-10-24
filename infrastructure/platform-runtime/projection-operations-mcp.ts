import { readMcpStringArgument, type McpResourceHandler, type McpToolHandler } from "./mcp";
import type { ApiHostRuntime } from "./api";
import type { ProjectionOperationKind, ProjectionOperationState, PlatformControlPlane } from "./control-plane";
import {
  createProjectionStatusRefresher,
  enqueueProjectionOperation,
  readProjectionOperationsSnapshot,
  readProjectionWakeStatus,
  type ProjectionOperationsRouteOptions,
} from "./projection-operations-routes";
import {
  listProjectionBlockedStreamDetails,
  summarizeProjectionReplayStatuses,
} from "@chase-sets/bounded-context-runtime";

export type ProjectionOperationsMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

type ProjectionOperationsMcpOptions = ProjectionOperationsRouteOptions;

function requireActor(actor: Parameters<McpToolHandler>[0]["actor"]): NonNullable<typeof actor> {
  if (!actor) {
    throw new Error("An authenticated operator actor is required.");
  }
  return actor;
}

function readLimit(args: Readonly<Record<string, unknown>>) {
  const value = args.limit;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 500) : 50;
}

function readOperationState(value: string | null): ProjectionOperationState | undefined {
  return value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancel_requested" ||
    value === "cancelled"
    ? value
    : undefined;
}

function requireControlPlane(controlPlane: PlatformControlPlane | undefined): PlatformControlPlane {
  if (!controlPlane) {
    throw new Error("Projection operation control plane is unavailable.");
  }
  return controlPlane;
}

export function createProjectionOperationsMcpHandlers(
  runtime: ApiHostRuntime,
  options: ProjectionOperationsMcpOptions = {},
): ProjectionOperationsMcpHandlers {
  const refreshProjectionStatuses = createProjectionStatusRefresher(runtime);
  const routeOptions = options;

  const getSnapshot: McpToolHandler = async ({ actor }) => {
    requireActor(actor);
    return readProjectionOperationsSnapshot(runtime, routeOptions);
  };
  const getWakeStatus: McpToolHandler = async ({ actor }) => {
    requireActor(actor);
    return readProjectionWakeStatus(routeOptions);
  };
  const listBlockedStreams: McpToolHandler = async ({ actor, arguments: args }) => {
    requireActor(actor);
    const projectionKey = readMcpStringArgument(args, "projectionKey");
    if (!projectionKey) throw new Error("projectionKey is required.");
    return listProjectionBlockedStreamDetails(runtime, projectionKey, { poisonEventLimit: readLimit(args) });
  };
  const listOperations: McpToolHandler = async ({ actor, arguments: args }) => {
    requireActor(actor);
    const controlPlane = options.controlPlane;
    if (!controlPlane) return { operations: [] };
    const filter = {
      limit: readLimit(args),
      contextName: readMcpStringArgument(args, "contextName") ?? undefined,
      projectionName: readMcpStringArgument(args, "projectionName") ?? undefined,
      state: readOperationState(readMcpStringArgument(args, "state")),
      requestedByUserId: readMcpStringArgument(args, "requestedByUserId") ?? undefined,
    };
    return {
      operations: await controlPlane.listProjectionOperations(filter),
      operationSummary: await controlPlane.summarizeProjectionOperations(filter),
    };
  };
  const getOperation: McpToolHandler = async ({ actor, arguments: args }) => {
    requireActor(actor);
    const operationId = readMcpStringArgument(args, "operationId");
    if (!operationId) throw new Error("operationId is required.");
    const operation = await requireControlPlane(options.controlPlane).getProjectionOperation(operationId);
    if (!operation) throw new Error("Projection operation was not found.");
    return { operation };
  };
  const refresh: McpToolHandler = async ({ actor }) => {
    requireActor(actor);
    const projectionGroups = await refreshProjectionStatuses();
    return {
      summary: summarizeProjectionReplayStatuses(projectionGroups),
      projectionGroups,
      projectionStatusSource: "live-refresh" as const,
    };
  };
  const refreshCheckpoint: McpToolHandler = async ({ actor, arguments: args }) => {
    requireActor(actor);
    const targetContextName = readMcpStringArgument(args, "targetContextName");
    const projectionName = readMcpStringArgument(args, "projectionName");
    const sourceContextName = readMcpStringArgument(args, "sourceContextName");
    if (!targetContextName || !projectionName || !sourceContextName) {
      throw new Error("targetContextName, projectionName and sourceContextName are required.");
    }
    const projectionGroups = await refreshProjectionStatuses();
    const group = projectionGroups.find(
      (candidate) => candidate.targetContextName === targetContextName && candidate.projectionName === projectionName,
    );
    const positions =
      group?.subscriptions
        .filter((subscription) => subscription.sourceContextName === sourceContextName)
        .map((subscription) => subscription.lastGlobalPosition) ?? [];
    if (positions.length === 0) throw new Error("Projection checkpoint was not found.");
    return {
      lastGlobalPosition: positions.reduce((maximum, position) =>
        BigInt(position) > BigInt(maximum) ? position : maximum,
      ),
    };
  };
  const retryBlockedStream: McpToolHandler = async ({ actor, arguments: args }) => {
    const operator = requireActor(actor);
    const projectionKey = readMcpStringArgument(args, "projectionKey");
    const streamId = readMcpStringArgument(args, "streamId");
    if (!projectionKey || !streamId) throw new Error("projectionKey and streamId are required.");
    const operation = await enqueueProjectionOperation(options.controlPlane, operator, {
      operationKind: "retry-blocked-stream",
      contextName: projectionKey.includes(".") ? projectionKey.slice(0, projectionKey.indexOf(".")) : "unknown",
      projectionKey,
      streamId,
      progress: { message: "Retry queued." },
    });
    return { operation };
  };
  const cancelOperation: McpToolHandler = async ({ actor, arguments: args }) => {
    const operator = requireActor(actor);
    const operationId = readMcpStringArgument(args, "operationId");
    if (!operationId) throw new Error("operationId is required.");
    const cancelled = await requireControlPlane(options.controlPlane).cancelProjectionOperation({
      operationId,
      requestedByUserId: operator.userId,
    });
    return { result: { cancelled } };
  };
  const rebuild =
    (operationKind: Extract<ProjectionOperationKind, "rebuild-projection-group" | "rebuild-context">): McpToolHandler =>
    async ({ actor, arguments: args }) => {
      const operator = requireActor(actor);
      const contextName = readMcpStringArgument(args, "contextName");
      const confirm = readMcpStringArgument(args, "confirm");
      if (!contextName) throw new Error("contextName is required.");
      const expected = operationKind === "rebuild-context" ? "rebuild-all" : "rebuild";
      if (confirm !== expected) throw new Error(`Confirmation requires confirm = '${expected}'.`);
      const projectionName = readMcpStringArgument(args, "projectionName");
      if (operationKind === "rebuild-projection-group" && !projectionName) {
        throw new Error("projectionName is required.");
      }
      const operation = await enqueueProjectionOperation(options.controlPlane, operator, {
        operationKind,
        contextName,
        projectionName,
        progress: {
          message: operationKind === "rebuild-context" ? "Context rebuild queued." : "Projection group rebuild queued.",
        },
      });
      return { operation };
    };

  return {
    toolHandlers: {
      "projection-operations.get-snapshot": getSnapshot,
      "projection-operations.get-wake-status": getWakeStatus,
      "projection-operations.list-blocked-streams": listBlockedStreams,
      "projection-operations.list-operations": listOperations,
      "projection-operations.get-operation": getOperation,
      "projection-operations.refresh": refresh,
      "projection-operations.refresh-checkpoint": refreshCheckpoint,
      "projection-operations.retry-blocked-stream": retryBlockedStream,
      "projection-operations.cancel-operation": cancelOperation,
      "projection-operations.rebuild-projection-group": rebuild("rebuild-projection-group"),
      "projection-operations.rebuild-context": rebuild("rebuild-context"),
    },
    resourceHandlers: {},
  };
}
