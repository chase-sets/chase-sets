import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE,
  REPORTED_CONTENT_ACTIONS_REQUIRING_NOTE,
  type ReportedContentModerationAction,
  type ReportedContentTargetType,
} from "./contracts";
import { buildReportedContentProjectionHandlers } from "../read-model/projection";
import {
  getReportedContentQueueItem,
  getReportedContentQueueMetrics,
  listReportedContentQueue,
} from "../read-model/queries";

type ReportedContentRuntimeDeps = Readonly<{
  db: PgQueryable;
  eventStore: EventStore;
}>;

export type ReportedContentServices = Readonly<{
  listReportedContentQueue: (
    params: Parameters<typeof listReportedContentQueue>[1],
  ) => ReturnType<typeof listReportedContentQueue>;
  getReportedContentQueueItem: (targetType: string, targetId: string) => ReturnType<typeof getReportedContentQueueItem>;
  getReportedContentQueueMetrics: () => ReturnType<typeof getReportedContentQueueMetrics>;
  recordModerationAction: (
    params: Readonly<{
      targetType: string;
      targetId: string;
      action: ReportedContentModerationAction;
      note: string | null;
      operatorUserId: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ actionId: string; recordedAt: string }>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createReportedContentRuntime(deps: ReportedContentRuntimeDeps): ReportedContentServices {
  return {
    listReportedContentQueue: (params) => listReportedContentQueue(deps.db, params),
    getReportedContentQueueItem: (targetType, targetId) => getReportedContentQueueItem(deps.db, targetType, targetId),
    getReportedContentQueueMetrics: () => getReportedContentQueueMetrics(deps.db),
    recordModerationAction: async (params, context) => {
      const targetType = params.targetType as ReportedContentTargetType;
      const allowedActions = REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE[targetType];
      if (!allowedActions || !allowedActions.includes(params.action)) {
        throw new Error(`Action '${params.action}' is not valid for target type '${params.targetType}'.`);
      }
      if (REPORTED_CONTENT_ACTIONS_REQUIRING_NOTE.includes(params.action) && !params.note?.trim()) {
        // Every moderation action is an event with actor/reason (m108):
        // review-scoped actions require the operator to state why.
        throw new Error(`Action '${params.action}' requires a note.`);
      }

      const actionId = createId("rca");
      const recordedAt = new Date().toISOString();
      await deps.eventStore.appendToStream({
        streamId: `platform-operations.reported-content-${params.targetType}-${params.targetId}` as never,
        expectedVersion: "any",
        events: [
          {
            eventType: "platform-operations.reported-content.action-recorded",
            payload: {
              actionId,
              targetType: params.targetType,
              targetId: params.targetId,
              action: params.action,
              note: params.note,
              operatorUserId: params.operatorUserId,
              recordedAt,
            },
          },
        ],
        context,
      });
      return { actionId, recordedAt };
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "platform-operations-reported-content-action-projection",
        handlers: buildReportedContentProjectionHandlers(deps.db),
        streamPrefixes: ["platform-operations.reported-content-"],
      }),
    ],
  };
}
