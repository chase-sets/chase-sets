import { describe, expect, it } from "vitest";
import {
  compareOperationsAttentionItems,
  OPERATIONS_ATTENTION_SOURCES,
  OPERATIONS_ATTENTION_SOURCE_PRIORITY,
  operationsAttentionSourceById,
  type OperationsAttentionOrderInput,
} from "./ordering";

function order(overrides: Partial<OperationsAttentionOrderInput>): OperationsAttentionOrderInput {
  return {
    severity: "warning",
    source: "projection-blocked-stream",
    observedAt: "2026-07-14T00:00:00.000Z",
    dueAt: null,
    ...overrides,
  };
}

describe("compareOperationsAttentionItems", () => {
  it("orders by severity, descending", () => {
    const items = [
      order({ severity: "info", source: "platform-feedback-unreviewed" }),
      order({ severity: "critical", source: "projection-poison-event" }),
      order({ severity: "warning", source: "projection-blocked-stream" }),
    ];
    const sorted = [...items].sort(compareOperationsAttentionItems).map((item) => item.severity);
    expect(sorted).toEqual(["critical", "warning", "info"]);
  });

  it("puts a dated item ahead of an undated one at the same severity", () => {
    const dated = order({
      severity: "critical",
      source: "support-request-deadline",
      dueAt: "2026-07-14T09:00:00.000Z",
    });
    const undated = order({ severity: "critical", source: "projection-poison-event", dueAt: null });
    expect(compareOperationsAttentionItems(dated, undated)).toBeLessThan(0);
    expect(compareOperationsAttentionItems(undated, dated)).toBeGreaterThan(0);
  });

  it("orders dated items by soonest deadline first", () => {
    const soon = order({ severity: "critical", source: "support-request-deadline", dueAt: "2026-07-14T01:00:00.000Z" });
    const later = order({
      severity: "critical",
      source: "support-request-deadline",
      dueAt: "2026-07-14T05:00:00.000Z",
    });
    expect(compareOperationsAttentionItems(soon, later)).toBeLessThan(0);
  });

  it("breaks ties by source priority, then oldest observed, then source id", () => {
    const poison = order({ severity: "critical", source: "projection-poison-event", dueAt: null });
    const wake = order({ severity: "critical", source: "wake-stalled-job", dueAt: null });
    // Poison outranks wake by source priority when both are undated criticals.
    expect(compareOperationsAttentionItems(poison, wake)).toBeLessThan(0);
    expect(OPERATIONS_ATTENTION_SOURCE_PRIORITY["projection-poison-event"]).toBeGreaterThan(
      OPERATIONS_ATTENTION_SOURCE_PRIORITY["wake-stalled-job"],
    );

    const older = order({ observedAt: "2026-07-10T00:00:00.000Z" });
    const newer = order({ observedAt: "2026-07-13T00:00:00.000Z" });
    expect(compareOperationsAttentionItems(older, newer)).toBeLessThan(0);
  });

  it("is a deterministic total order (stable across shuffles)", () => {
    const items: OperationsAttentionOrderInput[] = [
      order({ severity: "critical", source: "projection-poison-event" }),
      order({ severity: "critical", source: "support-request-deadline", dueAt: "2026-07-14T02:00:00.000Z" }),
      order({ severity: "warning", source: "projection-blocked-stream" }),
      order({ severity: "info", source: "platform-feedback-unreviewed" }),
    ];
    const a = [...items].sort(compareOperationsAttentionItems);
    const b = [...items].reverse().sort(compareOperationsAttentionItems);
    expect(a).toEqual(b);
  });
});

describe("source registry", () => {
  it("declares a unique priority for every source", () => {
    const priorities = OPERATIONS_ATTENTION_SOURCES.map((source) => OPERATIONS_ATTENTION_SOURCE_PRIORITY[source.id]);
    expect(new Set(priorities).size).toBe(OPERATIONS_ATTENTION_SOURCES.length);
  });

  it("resolves a descriptor by id and builds a deep link", () => {
    const descriptor = operationsAttentionSourceById("support-request-deadline");
    expect(descriptor?.surface).toBe("support-operations");
    expect(descriptor?.buildHref("req-1")).toBe("/requests?requestId=req-1");
  });
});
