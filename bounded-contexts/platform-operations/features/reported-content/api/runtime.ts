import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { EVENT_STORE_READ_PAGE_SIZE_MAX, type StoredEvent } from "@chase-sets/event-core/storage";
import {
  parsePlatformOperationsListingRemovalDirectedPayload,
  parsePlatformOperationsReportedContentActionRecordedPayload,
} from "@chase-sets/event-core/public-event-payloads";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import { parseReportedContentAcknowledgement } from "./acknowledgement";
import {
  parseReportedContentModerationCommand,
  ReportedContentActionRejectedError,
  type ReportedContentModerationAction,
} from "./contracts";
import { buildReportedContentProjectionHandlers } from "../read-model/projection";
import {
  getReportedContentQueueItem,
  getReportedContentQueueMetrics,
  isReportedContentTargetQueued,
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
  acknowledge: (
    params: Readonly<{ targetType: string; targetId: string; operatorUserId: string | null }>,
    context: EventStoreContext,
  ) => Promise<{ acknowledgedAt: string }>;
  /** Rejects with a `ReportedContentActionRejectedError` before appending anything. */
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
    acknowledge: async (params, context) => {
      // The same stream version as disposition serializes the two commands even
      // while its projection is stale. A conflict is retried against fresh history.
      const streamId = `platform-operations.reported-content-${params.targetType}-${params.targetId}`;
      for (let attempt = 0; attempt < 8; attempt++) {
        const item = await getReportedContentQueueItem(deps.db, params.targetType, params.targetId);
        if (!item) throw new ReportedContentActionRejectedError("target-not-queued");
        const history: StoredEvent[] = [];
        for (;;) {
          const page = await deps.eventStore.readStream({
            streamId,
            fromVersion: (history.at(-1)?.streamVersion ?? 0) + 1,
            limit: EVENT_STORE_READ_PAGE_SIZE_MAX,
          });
          history.push(...page);
          if (page.length < EVENT_STORE_READ_PAGE_SIZE_MAX) break;
        }
        const startedAt = item.response_started_at ?? item.first_reported_at;
        const action = [...history]
          .reverse()
          .find((event) => event.eventType === "platform-operations.reported-content.action-recorded");
        if (!item.response_open || (action && Date.parse(String(action.payload.recordedAt)) >= Date.parse(startedAt))) {
          throw new ReportedContentActionRejectedError("target-disposed");
        }
        const prior = history.find(
          (event) =>
            event.eventType === "platform-operations.reported-content.acknowledged" &&
            Date.parse(String(event.payload.startedAt)) === Date.parse(startedAt),
        );
        if (prior) return { acknowledgedAt: String(prior.payload.acknowledgedAt) };
        const payload = parseReportedContentAcknowledgement({
          ...params,
          startedAt,
          acknowledgedAt: new Date().toISOString(),
        });
        try {
          await deps.eventStore.appendToStream({
            streamId,
            expectedVersion: history.at(-1)?.streamVersion ?? "no_stream",
            events: [{ eventType: "platform-operations.reported-content.acknowledged", payload: { ...payload } }],
            context,
          });
          return { acknowledgedAt: payload.acknowledgedAt };
        } catch (error) {
          if ((error as { code?: string }).code !== "concurrency_conflict") throw error;
        }
      }
      throw new Error("reported-content-acknowledgement-conflict");
    },
    recordModerationAction: async (params, context) => {
      const command = parseReportedContentModerationCommand(params);
      if (!(await isReportedContentTargetQueued(deps.db, command.targetType, command.targetId))) {
        throw new ReportedContentActionRejectedError("target-not-queued");
      }

      const actionId = createId("rca");
      const recordedAt = new Date().toISOString();
      const audit = parsePlatformOperationsReportedContentActionRecordedPayload({
        actionId,
        targetType: command.targetType,
        targetId: command.targetId,
        action: command.action,
        note: command.note,
        operatorUserId: params.operatorUserId,
        recordedAt,
      });
      const directive =
        audit.targetType === "listing" && audit.action === "unlist"
          ? parseListingRemovalDirective({
              actionId,
              listingId: audit.targetId,
              operatorUserId: audit.operatorUserId,
              directedAt: recordedAt,
            })
          : null;
      await deps.eventStore.appendToStream({
        streamId: `platform-operations.reported-content-${audit.targetType}-${audit.targetId}` as never,
        expectedVersion: "any",
        events: [
          {
            eventType: "platform-operations.reported-content.action-recorded",
            payload: audit,
          },
          ...(directive
            ? [
                {
                  eventType: "platform-operations.reported-content.listing-removal-directed",
                  payload: directive,
                },
              ]
            : []),
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

function parseListingRemovalDirective(value: unknown) {
  try {
    return parsePlatformOperationsListingRemovalDirectedPayload(value);
  } catch {
    throw new ReportedContentActionRejectedError("invalid-listing-removal-directive");
  }
}
