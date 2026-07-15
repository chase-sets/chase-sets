// Composition root for the operations attention queue. It wires each owning
// slice's existing request-scoped read into a queue source, gated by the
// operator's permissions, then hands the sources to the shared aggregation. Each
// source fetches independently so one failing read degrades only its own row.
// This is thin glue: all severity/ordering/degradation policy lives in the
// read model.

import {
  loadProjectionOperationsSnapshot,
  loadWakeStatusSnapshot,
} from "../../features/projection-operations/api/client";
import {
  buildBlockedRows,
  type ProjectionOperationsSnapshot,
} from "../../features/projection-operations/read-model/contracts";
import type { WakeStatusSnapshot } from "../../features/projection-operations/read-model/wake-status-contracts";
import {
  aggregateOperationsAttentionQueue,
  type OperationsAttentionQueue,
  type OperationsAttentionSource,
} from "../../features/operations-attention-queue/read-model/attention-queue";
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
} from "../../features/operations-attention-queue/read-model/sources";
import { createExperienceRequestApiClient } from "./api-client";
import { createSupportRequestRequestApiClient } from "./support-request-api-client";

const QUEUE_READ_LIMIT = "100";

function collectPoisonEvents(snapshot: ProjectionOperationsSnapshot): readonly PoisonEventInput[] {
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

function collectBlockedStreams(snapshot: ProjectionOperationsSnapshot): readonly BlockedStreamInput[] {
  return buildBlockedRows(snapshot).map((stream) => ({
    projectionKey: stream.projectionKey,
    streamId: stream.streamId,
    deferredEventCount: stream.deferredEventCount,
  }));
}

function toWakeStoreInput(snapshot: WakeStatusSnapshot): WakeStoreInput {
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

// Build the queue for one operator. `actorPermissions` selects the visible
// sources; `now` is injectable so the surface's evaluation instant is
// deterministic and testable.
export async function loadOperationsAttentionQueue(
  request: Request,
  actorPermissions: readonly string[],
  options: Readonly<{ now?: string }> = {},
): Promise<OperationsAttentionQueue> {
  const now = options.now ?? new Date().toISOString();

  // Poison events and blocked streams both read the one projection snapshot;
  // fetch it once and share, so a single projection-console outage degrades both
  // together and never double-loads.
  let projectionSnapshotPromise: Promise<ProjectionOperationsSnapshot> | null = null;
  const projectionSnapshot = () => {
    projectionSnapshotPromise ??= loadProjectionOperationsSnapshot(request);
    return projectionSnapshotPromise;
  };

  const sources: OperationsAttentionSource[] = [];

  if (canViewOperationsAttentionSource("projection-poison-event", actorPermissions)) {
    sources.push({
      id: "projection-poison-event",
      load: async (context) => mapPoisonEventsToItems(collectPoisonEvents(await projectionSnapshot()), context),
    });
  }

  if (canViewOperationsAttentionSource("projection-blocked-stream", actorPermissions)) {
    sources.push({
      id: "projection-blocked-stream",
      load: async (context) => mapBlockedStreamsToItems(collectBlockedStreams(await projectionSnapshot()), context),
    });
  }

  if (canViewOperationsAttentionSource("wake-stalled-job", actorPermissions)) {
    sources.push({
      id: "wake-stalled-job",
      load: async (context) => {
        const wake = await loadWakeStatusSnapshot(request);
        if (wake === null) {
          throw new Error("wake status unavailable");
        }
        if (!wake.wakeStore.available) {
          return [];
        }
        return mapWakeStoreToItems(toWakeStoreInput(wake), context);
      },
    });
  }

  if (canViewOperationsAttentionSource("support-request-deadline", actorPermissions)) {
    sources.push({
      id: "support-request-deadline",
      load: async (context) => {
        const api = createSupportRequestRequestApiClient(request);
        const query = new URLSearchParams({ limit: QUEUE_READ_LIMIT, offset: "0", now }).toString();
        const queue = await api.listSupportOperationsQueue(query);
        return mapSupportRequestsToItems(queue.items, context);
      },
    });
  }

  if (canViewOperationsAttentionSource("platform-feedback-unreviewed", actorPermissions)) {
    sources.push({
      id: "platform-feedback-unreviewed",
      load: async (context) => {
        const api = createExperienceRequestApiClient(request);
        const query = new URLSearchParams({ status: "new", limit: QUEUE_READ_LIMIT, offset: "0" }).toString();
        const feedback = await api.listPlatformFeedback(query);
        return mapPlatformFeedbackToItems(feedback.items, context);
      },
    });
  }

  return aggregateOperationsAttentionQueue(sources, { now });
}
