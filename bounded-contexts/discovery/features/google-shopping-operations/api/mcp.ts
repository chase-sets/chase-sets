import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { readMcpStringArgument, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import {
  toGoogleShoppingFullSyncJobStatus,
  type GoogleShoppingFeedRowFilter,
  type GoogleShoppingSyncMode,
  type GoogleShoppingSyncServices,
} from "./sync-job";

export type GoogleShoppingMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
}>;

const GOOGLE_SHOPPING_PERMISSION = "google-shopping.manage";

function requireOperator(actor: ResolvedActor | null): ResolvedActor {
  if (!actor) {
    throw new Error("An authenticated operator is required.");
  }
  if (!actor.permissions.includes(GOOGLE_SHOPPING_PERMISSION)) {
    throw new Error(`Missing required permission: ${GOOGLE_SHOPPING_PERMISSION}.`);
  }
  return actor;
}

function readOptionalPositiveInteger(args: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return parsed;
}

function readDryRunMode(args: Readonly<Record<string, unknown>>): GoogleShoppingSyncMode {
  const mode = readMcpStringArgument(args, "mode") ?? "dry-run";
  if (mode !== "dry-run") {
    throw new Error("Google Shopping MCP tools only support dry-run mode.");
  }
  return mode;
}

function readRequiredString(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = readMcpStringArgument(args, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function readFeedRowFilter(args: Readonly<Record<string, unknown>>): GoogleShoppingFeedRowFilter | undefined {
  const filter = readMcpStringArgument(args, "filter");
  if (!filter) {
    return undefined;
  }

  const allowed: readonly GoogleShoppingFeedRowFilter[] = [
    "all",
    "eligible",
    "excluded",
    "failed",
    "disapproved",
    "pending-delete",
    "nearing-refresh",
    "stale",
    "pending-diagnostics",
  ];
  if (!allowed.includes(filter as GoogleShoppingFeedRowFilter)) {
    throw new Error("filter is not a supported Google Shopping feed-row filter.");
  }
  return filter as GoogleShoppingFeedRowFilter;
}

export function createGoogleShoppingMcpHandlers(services: GoogleShoppingSyncServices): GoogleShoppingMcpHandlers {
  const enqueueDiagnosticsRefresh: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor);
    const job = await services.enqueueDiagnosticsRefreshJob(
      { mode: readDryRunMode(args), batchSize: readOptionalPositiveInteger(args, "batchSize") },
      createActorEventStoreContext(scopedActor),
    );
    return toGoogleShoppingFullSyncJobStatus(job);
  };

  const enqueueFullSync: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor);
    const job = await services.enqueueFullSyncJob(
      { mode: readDryRunMode(args), batchSize: readOptionalPositiveInteger(args, "batchSize") },
      createActorEventStoreContext(scopedActor),
    );
    return toGoogleShoppingFullSyncJobStatus(job);
  };

  const enqueueMaintenanceSync: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor);
    const result = await services.enqueueMaintenanceSyncJob(
      {
        mode: readDryRunMode(args),
        limit: readOptionalPositiveInteger(args, "limit"),
        refreshWindowDays: readOptionalPositiveInteger(args, "refreshWindowDays"),
      },
      createActorEventStoreContext(scopedActor),
    );
    return {
      summary: result.summary,
      job: result.job ? toGoogleShoppingFullSyncJobStatus(result.job) : null,
    };
  };

  const getSyncJob: McpToolHandler = async ({ actor, arguments: args }) => {
    requireOperator(actor);
    const job = await services.getFullSyncJob(readRequiredString(args, "jobId"));
    if (!job) {
      throw new Error("Google Shopping sync job not found.");
    }
    return toGoogleShoppingFullSyncJobStatus(job);
  };

  const listFeedRows: McpToolHandler = async ({ actor, arguments: args }) => {
    requireOperator(actor);
    return services.listFeedRows({
      filter: readFeedRowFilter(args),
      search: readMcpStringArgument(args, "search") ?? undefined,
      limit: readOptionalPositiveInteger(args, "limit"),
      refreshWindowDays: readOptionalPositiveInteger(args, "refreshWindowDays"),
    });
  };

  return {
    toolHandlers: {
      "discovery.enqueue-google-shopping-diagnostics-refresh": enqueueDiagnosticsRefresh,
      "discovery.enqueue-google-shopping-dry-run-full-sync": enqueueFullSync,
      "discovery.enqueue-google-shopping-dry-run-maintenance-sync": enqueueMaintenanceSync,
      "discovery.get-google-shopping-sync-job": getSyncJob,
      "discovery.list-google-shopping-feed-rows": listFeedRows,
    },
  };
}
