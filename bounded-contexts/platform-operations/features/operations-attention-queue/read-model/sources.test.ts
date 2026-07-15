import { describe, expect, it } from "vitest";
import { aggregateOperationsAttentionQueue, type OperationsAttentionContext } from "./attention-queue";
import {
  canViewOperationsAttentionSource,
  mapBlockedStreamsToItems,
  mapPlatformFeedbackToItems,
  mapPoisonEventsToItems,
  mapSupportRequestsToItems,
  mapWakeStoreToItems,
  operationsAttentionSourcesForPermissions,
} from "./sources";

const CONTEXT: OperationsAttentionContext = { now: "2026-07-14T12:00:00.000Z" };

describe("mapPoisonEventsToItems", () => {
  it("maps a poison event to a critical, undated item anchored to first-seen", () => {
    const [item] = mapPoisonEventsToItems(
      [
        {
          projectionKey: "ordering.orders",
          eventId: "evt-9",
          eventType: "order.placed",
          streamId: "order-1",
          retryCount: 3,
          firstSeenAt: "2026-07-14T06:00:00.000Z",
        },
      ],
      CONTEXT,
    );
    expect(item?.severity).toBe("critical");
    expect(item?.dueAt).toBeNull();
    expect(item?.observedAt).toBe("2026-07-14T06:00:00.000Z");
    expect(item?.deepLink.href).toBe("/projections?tab=blocked");
  });
});

describe("mapBlockedStreamsToItems", () => {
  it("maps a blocked stream to a warning item keyed by projection and stream", () => {
    const [item] = mapBlockedStreamsToItems(
      [{ projectionKey: "catalog.items", streamId: "stream-2", deferredEventCount: 12 }],
      CONTEXT,
    );
    expect(item?.severity).toBe("warning");
    expect(item?.id).toBe("projection-blocked-stream:catalog.items:stream-2");
    expect(item?.observedAt).toBe(CONTEXT.now);
  });
});

describe("mapWakeStoreToItems", () => {
  it("emits one item per non-zero tally with its count, failed as critical", () => {
    const items = mapWakeStoreToItems(
      {
        failedCount: 2,
        staleClaimCount: 1,
        expiredCount: 0,
        oldestQueuedAt: "2026-07-14T05:00:00.000Z",
        oldestClaimedAt: null,
        generatedAt: "2026-07-14T12:00:00.000Z",
      },
      CONTEXT,
    );
    expect(items.map((item) => item.id)).toEqual(["wake-stalled-job:failed-intents", "wake-stalled-job:stale-claims"]);
    expect(items[0]?.severity).toBe("critical");
    expect(items[0]?.count).toBe(2);
    expect(items[1]?.severity).toBe("warning");
  });

  it("emits nothing when every tally is zero", () => {
    const items = mapWakeStoreToItems(
      {
        failedCount: 0,
        staleClaimCount: 0,
        expiredCount: 0,
        oldestQueuedAt: null,
        oldestClaimedAt: null,
        generatedAt: CONTEXT.now,
      },
      CONTEXT,
    );
    expect(items).toHaveLength(0);
  });
});

describe("mapSupportRequestsToItems", () => {
  it("marks a request past its earliest deadline as critical and carries that deadline", () => {
    const [item] = mapSupportRequestsToItems(
      [
        {
          support_request_id: "req-7",
          display_reference: "CASE-7",
          seller_response_due_at: "2026-07-14T09:00:00.000Z",
          support_review_due_at: "2026-07-15T00:00:00.000Z",
          seller_condition_attestation_due_at: null,
          updated_at: "2026-07-13T00:00:00.000Z",
        },
      ],
      CONTEXT,
    );
    expect(item?.severity).toBe("critical");
    expect(item?.dueAt).toBe("2026-07-14T09:00:00.000Z");
    expect(item?.deepLink.href).toBe("/requests?requestId=req-7");
  });

  it("marks a request still within its window as a warning", () => {
    const [item] = mapSupportRequestsToItems(
      [
        {
          support_request_id: "req-8",
          display_reference: "CASE-8",
          seller_response_due_at: "2026-07-14T18:00:00.000Z",
          support_review_due_at: null,
          seller_condition_attestation_due_at: null,
          updated_at: "2026-07-14T00:00:00.000Z",
        },
      ],
      CONTEXT,
    );
    expect(item?.severity).toBe("warning");
    expect(item?.dueAt).toBe("2026-07-14T18:00:00.000Z");
  });

  it("escalates an action-required case even without a passed deadline", () => {
    const [item] = mapSupportRequestsToItems(
      [
        {
          support_request_id: "req-9",
          display_reference: "CASE-9",
          seller_response_due_at: null,
          support_review_due_at: null,
          seller_condition_attestation_due_at: null,
          updated_at: "2026-07-14T00:00:00.000Z",
          case_presentation: "action-required",
        },
      ],
      CONTEXT,
    );
    expect(item?.severity).toBe("critical");
    expect(item?.dueAt).toBeNull();
  });
});

describe("mapPlatformFeedbackToItems", () => {
  it("maps unreviewed feedback to an informational item deep-linking to its detail", () => {
    const [item] = mapPlatformFeedbackToItems(
      [{ feedback_id: "fb-3", topic: "checkout", submitted_at: "2026-07-14T10:00:00.000Z" }],
      CONTEXT,
    );
    expect(item?.severity).toBe("info");
    expect(item?.deepLink.href).toBe("/platform-feedback/fb-3");
  });
});

describe("operator RBAC", () => {
  it("includes only the sources the operator's permissions cover", () => {
    const sources = operationsAttentionSourcesForPermissions(["projection-operations.view"]);
    expect(sources.map((source) => source.id).sort()).toEqual([
      "projection-blocked-stream",
      "projection-poison-event",
      "wake-stalled-job",
    ]);
    expect(canViewOperationsAttentionSource("support-request-deadline", ["projection-operations.view"])).toBe(false);
    expect(canViewOperationsAttentionSource("support-request-deadline", ["support.manage"])).toBe(true);
  });

  it("grants every source to an operator holding all the required permissions", () => {
    const all = operationsAttentionSourcesForPermissions([
      "projection-operations.view",
      "support.manage",
      "platform-feedback.view",
    ]);
    expect(all).toHaveLength(5);
  });
});

describe("the review scenario end to end", () => {
  it("orders one poison event, one blocked stream, and one support request due today", async () => {
    const queue = await aggregateOperationsAttentionQueue(
      [
        {
          id: "projection-poison-event",
          load: async (context) =>
            mapPoisonEventsToItems(
              [
                {
                  projectionKey: "ordering.orders",
                  eventId: "evt-1",
                  eventType: "order.placed",
                  streamId: "order-1",
                  retryCount: 1,
                  firstSeenAt: "2026-07-14T06:00:00.000Z",
                },
              ],
              context,
            ),
        },
        {
          id: "projection-blocked-stream",
          load: async (context) =>
            mapBlockedStreamsToItems(
              [{ projectionKey: "catalog.items", streamId: "s-1", deferredEventCount: 4 }],
              context,
            ),
        },
        {
          id: "support-request-deadline",
          load: async (context) =>
            mapSupportRequestsToItems(
              [
                {
                  support_request_id: "req-1",
                  display_reference: "CASE-1",
                  seller_response_due_at: "2026-07-14T09:00:00.000Z",
                  support_review_due_at: null,
                  seller_condition_attestation_due_at: null,
                  updated_at: "2026-07-13T00:00:00.000Z",
                },
              ],
              context,
            ),
        },
      ],
      CONTEXT,
    );

    expect(queue.items.map((item) => item.source)).toEqual([
      "support-request-deadline",
      "projection-poison-event",
      "projection-blocked-stream",
    ]);
    expect(queue.degraded).toBe(false);
    // Every item reaches its fix in one click.
    expect(queue.items.every((item) => item.deepLink.href.length > 0)).toBe(true);
  });
});
