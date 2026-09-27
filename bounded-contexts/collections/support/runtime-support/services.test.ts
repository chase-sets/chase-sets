import { describe, expect, it, vi } from "vitest";
import { createCollectionsServices } from "./services";

describe("Collections runtime-support composition", () => {
  it("preserves the Saved List analytics recorder identity", () => {
    const recorder = { record: vi.fn() };
    expect(
      createCollectionsServices({} as never, { savedListAnalyticsRecorder: recorder }).savedListAnalyticsRecorder,
    ).toBe(recorder);
  });
});
