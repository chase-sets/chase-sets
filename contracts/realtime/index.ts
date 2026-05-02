export type RealtimeProjectionPatchChange =
  | Readonly<{ op: "upsert"; entity: string; id: string; value: unknown }>
  | Readonly<{ op: "remove"; entity: string; id: string }>
  | Readonly<{ op: "summary"; entity: string; id: string; value: unknown }>;

export type RealtimeProjectionPatch = Readonly<{
  kind: "projection.patch";
  context: string;
  projection: string;
  topics: readonly string[];
  changes: readonly RealtimeProjectionPatchChange[];
}>;

export type RealtimeSyncRequired = Readonly<{
  kind: "sync.required";
  reason: "cursor-expired" | "replay-backpressure";
  contexts: readonly string[];
}>;

export type RealtimeMessage = RealtimeProjectionPatch | RealtimeSyncRequired;

export function isRealtimeProjectionPatch(value: unknown): value is RealtimeProjectionPatch {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.kind === "projection.patch" &&
    typeof value.context === "string" &&
    value.context.length > 0 &&
    typeof value.projection === "string" &&
    value.projection.length > 0 &&
    Array.isArray(value.topics) &&
    value.topics.every((topic) => typeof topic === "string" && topic.length > 0) &&
    Array.isArray(value.changes) &&
    value.changes.length > 0 &&
    value.changes.every(isRealtimeProjectionPatchChange)
  );
}

export function isRealtimeSyncRequired(value: unknown): value is RealtimeSyncRequired {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.kind === "sync.required" &&
    (value.reason === "cursor-expired" || value.reason === "replay-backpressure") &&
    Array.isArray(value.contexts) &&
    value.contexts.every((context) => typeof context === "string" && context.length > 0)
  );
}

function isRealtimeProjectionPatchChange(value: unknown): value is RealtimeProjectionPatchChange {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.entity !== "string" ||
    value.entity.length === 0 ||
    typeof value.id !== "string" ||
    value.id.length === 0
  ) {
    return false;
  }

  if (value.op === "remove") {
    return true;
  }

  return (value.op === "upsert" || value.op === "summary") && "value" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
