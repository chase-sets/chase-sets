import { describe, expect, it, vi } from "vitest";
import {
  action as itemDetailRailAnalyticsAction,
  loader as itemDetailRailAnalyticsLoader,
} from "./item-detail-rail-analytics";
import { registerItemDetailRailAnalyticsRecorder } from "@chase-sets/platform-runtime/analytics-recorder";

describe("Discovery item-detail rail analytics", () => {
  it("captures bounded item-detail rail analytics events", async () => {
    const response = await itemDetailRailAnalyticsAction({
      request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "payout_preview_shown",
          intent: "sell",
          workflow: "selected_offer",
          selection: "explicit",
          topic: "estimated_payout",
          outcome: "shown",
          viewer: "guest",
          surface: "action_rail",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(response.status).toBe(204);
  });

  it("captures Result Set click hashes and rejects raw query text", async () => {
    const accepted = await itemDetailRailAnalyticsAction({
      request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "search_result_selected",
          surface: "search_results",
          position: 1,
          queryHash: "a".repeat(64),
          resultSetKey: "b".repeat(64),
        }),
      }),
      params: {},
      context: undefined,
    } as never);
    const rejected = await itemDetailRailAnalyticsAction({
      request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "search_result_selected",
          surface: "search_results",
          position: 1,
          queryHash: "private-pikachu-query",
          resultSetKey: "b".repeat(64),
        }),
      }),
      params: {},
      context: undefined,
    } as never);
    const rejectedStringPosition = await itemDetailRailAnalyticsAction({
      request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "search_result_selected",
          surface: "search_results",
          position: "1",
          queryHash: "a".repeat(64),
          resultSetKey: "b".repeat(64),
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(accepted.status).toBe(204);
    expect(rejected.status).toBe(400);
    expect(rejectedStringPosition.status).toBe(400);
  });

  it("rejects unsupported or unbounded rail analytics events before logging", async () => {
    const unsupported = await itemDetailRailAnalyticsAction({
      request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "email_submitted", email: "seller@example.com" }),
      }),
      params: {},
      context: undefined,
    } as never);
    const unbounded = await itemDetailRailAnalyticsAction({
      request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "reference_info_opened",
          topic: "seller@example.com",
          surface: "action rail",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(unsupported.status).toBe(400);
    expect(unbounded.status).toBe(400);
    expect(
      itemDetailRailAnalyticsLoader({
        request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail"),
        params: {},
        context: undefined,
      } as never).status,
    ).toBe(405);
  });

  it("item-detail-rail analytics route preserves 204/400/405 contract", async () => {
    const recorder = vi.fn();
    const restore = registerItemDetailRailAnalyticsRecorder(recorder);
    const invoke = (body: unknown, method = "POST") =>
      itemDetailRailAnalyticsAction({
        request: new Request("https://marketplace.example/analytics/item-detail-rail", {
          method,
          body: JSON.stringify(body),
        }),
      } as Parameters<typeof itemDetailRailAnalyticsAction>[0]);
    try {
      const invalid = [
        null,
        [],
        "invalid",
        {},
        { event: "unknown" },
        ...["intent", "workflow", "selection", "topic", "outcome", "gate", "viewer", "surface"].flatMap((field) =>
          ["a".repeat(81), "private text", "", 4].map((value) => ({ event: "rail_intent_selected", [field]: value })),
        ),
        ...["queryHash", "resultSetKey"].flatMap((field) =>
          ["a".repeat(63), "A".repeat(64), "a".repeat(65), 4].map((value) => ({
            event: "rail_intent_selected",
            [field]: value,
          })),
        ),
        ...[0, -1, 1.1, 10001, "1"].map((position) => ({ event: "rail_intent_selected", position })),
      ];
      for (const body of invalid) {
        const response = await invoke(body);
        expect(response.status).toBe(400);
        expect(await response.text()).toBe("Invalid item detail rail analytics event.");
      }
      expect(recorder).not.toHaveBeenCalled();
      const emptyLabels = {
        intent: null,
        workflow: null,
        selection: null,
        topic: null,
        outcome: null,
        gate: null,
        viewer: null,
        surface: null,
        position: null,
        queryHash: null,
        resultSetKey: null,
      };
      for (const optionalFields of [{}, emptyLabels]) {
        expect((await invoke({ event: "rail_intent_selected", ...optionalFields })).status).toBe(204);
        expect(recorder.mock.lastCall?.[0]).toEqual({ event: "rail_intent_selected", ...emptyLabels });
      }
      for (const field of ["intent", "workflow", "selection", "topic", "outcome", "gate", "viewer", "surface"]) {
        expect((await invoke({ event: "rail_intent_selected", [field]: "a".repeat(80) })).status).toBe(204);
      }
      const before = recorder.mock.calls.length;
      expect(
        (
          await invoke({
            event: "search_result_selected",
            position: 10000,
            queryHash: "a".repeat(64),
            resultSetKey: "b".repeat(64),
            email: "private@example.test",
          })
        ).status,
      ).toBe(204);
      expect(recorder).toHaveBeenCalledTimes(before + 1);
      expect(recorder.mock.lastCall?.[0]).not.toHaveProperty("email");
      const method = await invoke({}, "PUT");
      expect(method.status).toBe(405);
      expect(method.headers.get("Allow")).toBe("POST");
      const get = itemDetailRailAnalyticsLoader({} as Parameters<typeof itemDetailRailAnalyticsLoader>[0]);
      expect(get.status).toBe(405);
      expect(get.headers.get("Allow")).toBe("POST");
      const malformed = await itemDetailRailAnalyticsAction({
        request: new Request("https://marketplace.example/analytics/item-detail-rail", { method: "POST", body: "{" }),
      } as Parameters<typeof itemDetailRailAnalyticsAction>[0]);
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).toBe("Invalid item detail rail analytics event.");
    } finally {
      restore();
    }
    const restoreAbsent = registerItemDetailRailAnalyticsRecorder(null);
    try {
      expect((await invoke({ event: "rail_intent_selected" })).status).toBe(204);
    } finally {
      restoreAbsent();
    }
  });
});
