import {
  emptySchema,
  idempotencyKeyProperty,
  integerProperty,
  objectSchema,
  readTool,
  stringProperty,
  writeTool,
  type McpServiceDescriptor,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

const operatorRead = "projection-operations.view";
const operatorOperate = "projection-operations.operate";
const operatorRebuild = "projection-operations.rebuild";
const confirmationText = stringProperty("Exact tool-title confirmation text.");

const writeFields = {
  idempotencyKey: idempotencyKeyProperty(),
  confirmationText,
};

export const projectionOperationsService = {
  serviceId: "projection-operations",
  serviceName: "Projection Operations",
  kind: "infrastructure",
  owner: "infrastructure/platform-runtime",
  packageName: "@chase-sets/platform-runtime",
  serviceBoundary: "Operator projection incident snapshots, recovery actions, and rebuild operations.",
  tools: [
    {
      ...readTool(
        "projection-operations",
        "get-snapshot",
        "Get Projection Operations Snapshot",
        "Read projection groups, blocked projections, workers, runners, and queued operations.",
        operatorRead,
        emptySchema,
        "projection-operations",
        ["Use to inspect current projection health and queued operator work."],
        "operator",
      ),
      availability: "available",
    },
    {
      ...readTool(
        "projection-operations",
        "get-wake-status",
        "Get Projection Wake Status",
        "Read push-wake store, relay, scheduler, rollout, migration, and origin status.",
        operatorRead,
        emptySchema,
        "projection-wake-status",
        ["Use to inspect projection wake delivery and scheduler health."],
        "operator",
      ),
      availability: "available",
    },
    {
      ...readTool(
        "projection-operations",
        "list-blocked-streams",
        "List Blocked Projection Streams",
        "List blocked streams and poison events for one projection key.",
        operatorRead,
        objectSchema(
          {
            projectionKey: stringProperty("Projection checkpoint key."),
            limit: integerProperty("Maximum poison events to return."),
          },
          ["projectionKey"],
        ),
        "projection-blocked-stream",
        ["Use to identify repairable projection incidents."],
        "operator",
      ),
      availability: "available",
    },
    {
      ...readTool(
        "projection-operations",
        "list-operations",
        "List Projection Operations",
        "List queued, running, completed, and cancelled projection operations.",
        operatorRead,
        objectSchema(
          {
            contextName: stringProperty("Optional target context."),
            projectionName: stringProperty("Optional projection name."),
            state: stringProperty("Optional operation state.", [
              "queued",
              "running",
              "succeeded",
              "failed",
              "cancel_requested",
              "cancelled",
            ]),
            requestedByUserId: stringProperty("Optional requesting user."),
            limit: integerProperty("Maximum operations to return."),
          },
          [],
        ),
        "projection-operation",
        ["Use to inspect operation history and current work."],
        "operator",
      ),
      availability: "available",
    },
    {
      ...readTool(
        "projection-operations",
        "get-operation",
        "Get Projection Operation",
        "Read one projection operation and its terminal or in-progress state.",
        operatorRead,
        objectSchema({ operationId: stringProperty("Projection operation identifier.") }, ["operationId"]),
        "projection-operation",
        ["Use to follow a queued repair or rebuild."],
        "operator",
      ),
      availability: "available",
    },
    {
      ...writeTool(
        "projection-operations",
        "refresh",
        "Refresh Projection Status",
        "Refresh live projection group status.",
        operatorOperate,
        objectSchema(writeFields, ["idempotencyKey", "confirmationText"]),
        "projection-operations",
        ["Use after a projection incident changes state."],
        "sensitive",
        "operator",
      ),
      availability: "available",
    },
    {
      ...writeTool(
        "projection-operations",
        "refresh-checkpoint",
        "Refresh Projection Checkpoint",
        "Read the latest source checkpoint for a projection subscription.",
        operatorOperate,
        objectSchema(
          {
            targetContextName: stringProperty("Target context."),
            projectionName: stringProperty("Projection name."),
            sourceContextName: stringProperty("Source context."),
            ...writeFields,
          },
          ["targetContextName", "projectionName", "sourceContextName", "idempotencyKey", "confirmationText"],
        ),
        "projection-checkpoint",
        ["Use to inspect the authoritative source checkpoint before repair."],
        "sensitive",
        "operator",
      ),
      availability: "available",
    },
    {
      ...writeTool(
        "projection-operations",
        "retry-blocked-stream",
        "Retry Blocked Projection Stream",
        "Queue one retry for a blocked projection stream.",
        operatorOperate,
        objectSchema(
          {
            projectionKey: stringProperty("Projection checkpoint key."),
            streamId: stringProperty("Blocked stream identifier."),
            ...writeFields,
          },
          ["projectionKey", "streamId", "idempotencyKey", "confirmationText"],
        ),
        "projection-blocked-stream",
        ["Use to retry a repairable poison event after reviewing its snapshot."],
        "sensitive",
        "operator",
      ),
      availability: "available",
    },
    {
      ...writeTool(
        "projection-operations",
        "cancel-operation",
        "Cancel Projection Operation",
        "Request cancellation of one projection operation.",
        operatorOperate,
        objectSchema({ operationId: stringProperty("Projection operation identifier."), ...writeFields }, [
          "operationId",
          "idempotencyKey",
          "confirmationText",
        ]),
        "projection-operation",
        ["Use to stop an operation that should no longer run."],
        "sensitive",
        "operator",
      ),
      availability: "available",
    },
    {
      ...writeTool(
        "projection-operations",
        "rebuild-projection-group",
        "Rebuild Projection Group",
        "Queue a rebuild for one projection group.",
        operatorRebuild,
        objectSchema(
          {
            contextName: stringProperty("Target context."),
            projectionName: stringProperty("Projection name."),
            confirm: stringProperty("Must be exactly 'rebuild'."),
            ...writeFields,
          },
          ["contextName", "projectionName", "confirm", "idempotencyKey", "confirmationText"],
        ),
        "projection-group",
        ["Use only after confirming the exact projection group requires rebuild."],
        "destructive",
        "operator",
      ),
      availability: "available",
    },
    {
      ...writeTool(
        "projection-operations",
        "rebuild-context",
        "Rebuild Context",
        "Queue a rebuild for every projection in a context.",
        operatorRebuild,
        objectSchema(
          {
            contextName: stringProperty("Target context."),
            confirm: stringProperty("Must be exactly 'rebuild-all'."),
            ...writeFields,
          },
          ["contextName", "confirm", "idempotencyKey", "confirmationText"],
        ),
        "projection-context",
        ["Use only after confirming the exact context-wide rebuild."],
        "destructive",
        "operator",
      ),
      availability: "available",
    },
  ],
  resources: [],
} as const satisfies McpServiceDescriptor;
