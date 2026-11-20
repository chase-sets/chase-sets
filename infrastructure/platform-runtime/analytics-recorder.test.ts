import { describe, expect, it, vi } from "vitest";
import { recordPlatformItemDetailRailAnalytics, registerItemDetailRailAnalyticsRecorder } from "./analytics-recorder";

describe("analytics recorder port", () => {
  it("drops unregistered events and restores the preceding registration", () => {
    const event = { event: "fixture" };
    const restoreAbsent = registerItemDetailRailAnalyticsRecorder(null);
    const first = vi.fn();
    const second = vi.fn();
    const restoreFirst = registerItemDetailRailAnalyticsRecorder(first);
    const restoreSecond = registerItemDetailRailAnalyticsRecorder(second);
    try {
      recordPlatformItemDetailRailAnalytics(event);
      expect(second).toHaveBeenCalledWith(event);
      expect(first).not.toHaveBeenCalled();
      restoreSecond();
      recordPlatformItemDetailRailAnalytics(event);
      expect(first).toHaveBeenCalledWith(event);
      restoreFirst();
      expect(() => recordPlatformItemDetailRailAnalytics(event)).not.toThrow();
      expect(first).toHaveBeenCalledTimes(1);
    } finally {
      restoreSecond();
      restoreFirst();
      restoreAbsent();
    }
  });
});
