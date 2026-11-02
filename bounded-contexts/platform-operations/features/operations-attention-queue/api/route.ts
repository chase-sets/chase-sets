import { Hono } from "hono";
import type { PlatformOperationsApiEnv } from "../../../api";
import {
  aggregateOperationsAttentionQueue,
  type OperationsAttentionContext,
  type OperationsAttentionItem,
  type OperationsAttentionSource,
  type OperationsAttentionSourceResult,
} from "../read-model/attention-queue";
import {
  canViewOperationsAttentionSource,
  mapBlockedStreamsToItems,
  mapPlatformFeedbackToItems,
  mapPoisonEventsToItems,
  mapSupportRequestsToItems,
  mapWakeStoreToItems,
  type BlockedStreamInput,
  type PoisonEventInput,
  type WakeStoreInput,
} from "../read-model/sources";
import { OPERATIONS_ATTENTION_SOURCES, type OperationsAttentionSourceId } from "../read-model/ordering";
import type { ProjectionOperationsSnapshot } from "../../projection-operations/read-model/contracts";
import type { WakeStoreStatus } from "../../projection-operations/read-model/wake-status-contracts";
import type { PlatformOperationsServices } from "../../../support/runtime-support/services";

type OperationsAttentionServices = Pick<
  PlatformOperationsServices,
  "supportRequests" | "platformFeedback" | "operationsAttentionRuntimeReads"
>;

const QUEUE_READ_LIMIT = 100;

function collectPoisonEvents(
  snapshot: Readonly<{ blockedProjections: ProjectionOperationsSnapshot["blockedProjections"] }>,
): readonly PoisonEventInput[] {
  return snapshot.blockedProjections.flatMap((projection) =>
    projection.poisonEvents.map((event) => ({
      projectionKey: projection.projectionKey,
      eventId: event.eventId,
      eventType: event.eventType,
      streamId: event.streamId,
      retryCount: event.retryCount,
      firstSeenAt: event.firstSeenAt,
    })),
  );
}

function collectBlockedStreams(
  snapshot: Readonly<{ blockedProjections: ProjectionOperationsSnapshot["blockedProjections"] }>,
): readonly BlockedStreamInput[] {
  return snapshot.blockedProjections.flatMap((projection) =>
    projection.blockedStreams.map((stream) => ({
      projectionKey: projection.projectionKey,
      streamId: stream.streamId,
      deferredEventCount: stream.deferredEventCount,
    })),
  );
}

function toWakeStoreInput(
  snapshot: Readonly<{
    generatedAt: string;
    wakeStore: {
      intentSummary: Pick<
        WakeStoreInput,
        "failedCount" | "staleClaimCount" | "expiredCount" | "oldestQueuedAt" | "oldestClaimedAt"
      >;
    };
  }>,
): WakeStoreInput {
  const summary = snapshot.wakeStore.intentSummary;
  return {
    failedCount: summary.failedCount,
    staleClaimCount: summary.staleClaimCount,
    expiredCount: summary.expiredCount,
    oldestQueuedAt: summary.oldestQueuedAt,
    oldestClaimedAt: summary.oldestClaimedAt,
    generatedAt: snapshot.generatedAt,
  };
}

function authoritativeTotal(total: number, itemCount: number): number | "unknown" {
  return Number.isInteger(total) && total >= 0 && total <= itemCount ? total : "unknown";
}

function loaded(items: readonly OperationsAttentionItem[], total: number | "unknown"): OperationsAttentionSourceResult {
  return { items, total };
}

function notMounted(): never {
  throw new Error("not-mounted");
}

function sourceFor(
  id: OperationsAttentionSourceId,
  services: OperationsAttentionServices,
  blockedProjections: () => Promise<ProjectionOperationsSnapshot["blockedProjections"]>,
  wakeStatus: () => Promise<{ generatedAt: string; wakeStore: WakeStoreStatus } | null>,
): OperationsAttentionSource {
  switch (id) {
    case "projection-poison-event":
      return {
        id,
        load: async (context) =>
          loaded(
            mapPoisonEventsToItems(collectPoisonEvents({ blockedProjections: await blockedProjections() }), context),
            "unknown",
          ),
      };
    case "projection-blocked-stream":
      return {
        id,
        load: async (context) =>
          loaded(
            mapBlockedStreamsToItems(
              collectBlockedStreams({ blockedProjections: await blockedProjections() }),
              context,
            ),
            "unknown",
          ),
      };
    case "wake-stalled-job":
      return {
        id,
        load: async (context) => {
          const snapshot = await wakeStatus();
          if (snapshot === null) {
            throw new Error("wake status unavailable");
          }
          if (!snapshot.wakeStore.available) {
            return loaded([], "unknown");
          }
          return loaded(mapWakeStoreToItems(toWakeStoreInput(snapshot), context), "unknown");
        },
      };
    case "support-request-deadline":
      return {
        id,
        load: async (context) => {
          const result = await services.supportRequests.listSupportOperationsQueue({
            now: context.now,
            limit: QUEUE_READ_LIMIT,
            offset: 0,
          });
          return loaded(
            mapSupportRequestsToItems(result.items, context),
            authoritativeTotal(result.total, result.items.length),
          );
        },
      };
    case "platform-feedback-unreviewed":
      return {
        id,
        load: async (context) => {
          const result = await services.platformFeedback.listPlatformFeedback({
            status: "new",
            limit: QUEUE_READ_LIMIT,
            offset: 0,
          });
          return loaded(
            mapPlatformFeedbackToItems(result.items, context),
            authoritativeTotal(result.total, result.items.length),
          );
        },
      };
  }
}

export function createOperationsAttentionRoutes(services: OperationsAttentionServices) {
  const app = new Hono<PlatformOperationsApiEnv>();

  app.get("/", async (c) => {
    const actor = c.get("actor");
    if (!actor) {
      return c.json({ error: { code: "authentication_required" } }, 401);
    }

    const now = new Date().toISOString();
    const runtimeReads = services.operationsAttentionRuntimeReads;
    let blockedProjectionsPromise: Promise<ProjectionOperationsSnapshot["blockedProjections"]> | null = null;
    let wakeStatusPromise: Promise<{ generatedAt: string; wakeStore: WakeStoreStatus } | null> | null = null;
    const blockedProjections = () => {
      if (!runtimeReads) return notMounted();
      blockedProjectionsPromise ??= runtimeReads.loadBlockedProjections();
      return blockedProjectionsPromise;
    };
    const wakeStatus = (): Promise<{ generatedAt: string; wakeStore: WakeStoreStatus } | null> => {
      if (!runtimeReads) return notMounted();
      wakeStatusPromise ??= runtimeReads.loadWakeStatus();
      return wakeStatusPromise;
    };

    const sources = OPERATIONS_ATTENTION_SOURCES.filter(({ id }) =>
      canViewOperationsAttentionSource(id, actor.permissions),
    ).map(({ id }) => sourceFor(id, services, blockedProjections, wakeStatus));
    const queue = await aggregateOperationsAttentionQueue(sources, { now } satisfies OperationsAttentionContext);
    return c.json(queue);
  });

  return app;
}
