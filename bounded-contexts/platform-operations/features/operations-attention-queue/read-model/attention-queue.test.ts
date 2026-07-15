import { describe, expect, it } from "vitest";
import {
  aggregateOperationsAttentionQueue,
  buildOperationsAttentionItem,
  isOperationsAttentionItem,
  type OperationsAttentionContext,
  type OperationsAttentionItem,
  type OperationsAttentionSource,
} from "./attention-queue";

const CONTEXT: OperationsAttentionContext = { now: "2026-07-14T12:00:00.000Z" };

function poisonItem(overrides: Partial<OperationsAttentionItem> = {}): OperationsAttentionItem {
  return {
    ...buildOperationsAttentionItem({
      source: "projection-poison-event",
      entityId: "evt-1",
      severity: "critical",
      summary: { code: "poisonEvent", params: { eventType: "order.placed" } },
      observedAt: "2026-07-14T08:00:00.000Z",
    }),
    ...overrides,
  };
}

function staticSource(
  id: OperationsAttentionSource["id"],
  items: readonly OperationsAttentionItem[],
): OperationsAttentionSource {
  return { id, load: async () => items };
}

describe("buildOperationsAttentionItem", () => {
  it("derives a stable id, entity, and deep link from the source descriptor", () => {
    const item = poisonItem();
    expect(item.id).toBe("projection-poison-event:evt-1");
    expect(item.entity).toBe("poison-event");
    expect(item.deepLink).toEqual({ surface: "projection-operations", href: "/projections?tab=blocked" });
    expect(item.dueAt).toBeNull();
  });

  it("refuses a severity louder than the source's declared peak", () => {
    expect(() =>
      buildOperationsAttentionItem({
        source: "platform-feedback-unreviewed",
        entityId: "fb-1",
        severity: "critical",
        summary: { code: "feedbackUnreviewed", params: {} },
        observedAt: CONTEXT.now,
      }),
    ).toThrow(/peak severity/);
  });
});

describe("isOperationsAttentionItem", () => {
  it("accepts a conforming item for its source", () => {
    expect(isOperationsAttentionItem(poisonItem(), "projection-poison-event")).toBe(true);
  });

  it("rejects an item claiming a different source's identity", () => {
    expect(isOperationsAttentionItem(poisonItem(), "support-request-deadline")).toBe(false);
  });

  it("rejects a malformed item", () => {
    expect(isOperationsAttentionItem({ id: "x" }, "projection-poison-event")).toBe(false);
    expect(isOperationsAttentionItem(null, "projection-poison-event")).toBe(false);
  });
});

describe("aggregateOperationsAttentionQueue", () => {
  it("composes, orders, and rolls up counts from exactly the rendered items", async () => {
    const poison = poisonItem();
    const blocked = buildOperationsAttentionItem({
      source: "projection-blocked-stream",
      entityId: "proj:stream-1",
      severity: "warning",
      summary: { code: "blockedStream", params: {} },
      observedAt: "2026-07-14T07:00:00.000Z",
    });
    const support = buildOperationsAttentionItem({
      source: "support-request-deadline",
      entityId: "req-1",
      severity: "critical",
      summary: { code: "supportRequest", params: { reference: "CASE-1" } },
      observedAt: "2026-07-13T00:00:00.000Z",
      dueAt: "2026-07-14T12:00:00.000Z",
    });

    const queue = await aggregateOperationsAttentionQueue(
      [
        staticSource("projection-poison-event", [poison]),
        staticSource("projection-blocked-stream", [blocked]),
        staticSource("support-request-deadline", [support]),
      ],
      CONTEXT,
    );

    // A support request due now (dated critical) leads the two undated projection
    // items; the poison event (critical) precedes the blocked stream (warning).
    expect(queue.items.map((item) => item.id)).toEqual([
      "support-request-deadline:req-1",
      "projection-poison-event:evt-1",
      "projection-blocked-stream:proj:stream-1",
    ]);
    expect(queue.rollup.total).toBe(3);
    expect(queue.rollup.bySeverity).toEqual({ critical: 2, warning: 1, info: 0 });
    expect(queue.rollup.bySource["support-request-deadline"]).toBe(1);
    expect(queue.degraded).toBe(false);
    expect(queue.sources.every((source) => source.status === "available")).toBe(true);
  });

  it("degrades one failing source without blanking the queue", async () => {
    const throwing: OperationsAttentionSource = {
      id: "support-request-deadline",
      load: async () => {
        throw new Error("support read model unavailable");
      },
    };

    const queue = await aggregateOperationsAttentionQueue(
      [staticSource("projection-poison-event", [poisonItem()]), throwing],
      CONTEXT,
    );

    expect(queue.items.map((item) => item.id)).toEqual(["projection-poison-event:evt-1"]);
    expect(queue.degraded).toBe(true);
    const support = queue.sources.find((source) => source.id === "support-request-deadline");
    expect(support?.status).toBe("unavailable");
    expect(support?.reason).toContain("support read model unavailable");
    expect(queue.rollup.total).toBe(1);
  });

  it("marks a source that returns a non-conforming item as unavailable", async () => {
    const bad: OperationsAttentionSource = {
      id: "platform-feedback-unreviewed",
      // An item wearing the wrong source identity must not poison the queue.
      load: async () => [poisonItem()],
    };

    const queue = await aggregateOperationsAttentionQueue([bad], CONTEXT);

    expect(queue.items).toHaveLength(0);
    expect(queue.degraded).toBe(true);
    expect(queue.sources[0]?.status).toBe("unavailable");
    expect(queue.sources[0]?.reason).toContain("non-conforming");
  });

  it("preserves source health order as supplied", async () => {
    const queue = await aggregateOperationsAttentionQueue(
      [staticSource("wake-stalled-job", []), staticSource("projection-poison-event", [])],
      CONTEXT,
    );
    expect(queue.sources.map((source) => source.id)).toEqual(["wake-stalled-job", "projection-poison-event"]);
  });
});
