import { resolveProjectionDb, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { recordRealtimeProjectionPatch, type RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import type { OperationsAttentionSourceId } from "../read-model/ordering";
import { OPERATIONS_ATTENTION_REALTIME_TOPIC, platformOperationsRealtimeTopicPolicyManifest } from "./realtime-topics";

// Publishes an invalidation to the Operations Attention topic after each
// handled event of a queue source's projection, in the same transaction as the
// projection's write. The patch names only the source, never the entity, so a
// subscriber learns that the queue may have changed and reloads it through the
// queue API, which applies its per-source permissions.
export function withOperationsAttentionRealtimeInvalidation(
  handlers: ProjectorHandlerMap,
  db: PgQueryable,
  input: Readonly<{
    projectionName: string;
    source: OperationsAttentionSourceId;
  }>,
): ProjectorHandlerMap {
  return Object.fromEntries(
    Object.entries(handlers).map(([eventType, handler]) => [
      eventType,
      async (...args: Parameters<ProjectorHandlerMap[string]>) => {
        const [event, context] = args;
        await handler(event, context);
        const topics = [OPERATIONS_ATTENTION_REALTIME_TOPIC];
        await recordRealtimeProjectionPatch(resolveProjectionDb(context, db), {
          sourceGlobalPosition: event.globalPosition,
          projectionName: input.projectionName,
          patchKey: input.source,
          topics,
          topicPolicyManifest: platformOperationsRealtimeTopicPolicyManifest,
          recordedAt: event.timing.recordedAt,
          patch: createOperationsAttentionInvalidationPatch({
            projectionName: input.projectionName,
            source: input.source,
            topics,
          }),
        });
      },
    ]),
  );
}

export function createOperationsAttentionInvalidationPatch(
  input: Readonly<{
    projectionName: string;
    source: OperationsAttentionSourceId;
    topics: readonly string[];
  }>,
): RealtimeProjectionPatch {
  return {
    kind: "projection.patch",
    context: "platform-operations",
    projection: input.projectionName,
    topics: input.topics,
    changes: [
      {
        op: "summary",
        entity: "platformOperations.operationsAttention",
        id: input.source,
        value: { source: input.source },
      },
    ],
  };
}
