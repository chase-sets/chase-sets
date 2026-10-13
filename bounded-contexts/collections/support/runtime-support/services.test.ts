import { describe, expect, it, vi } from "vitest";
import { createCollectionsServices } from "./services";

describe("Collections runtime-support composition", () => {
  it("preserves the Saved List analytics recorder identity", () => {
    const recorder = { record: vi.fn() };
    expect(
      createCollectionsServices({} as never, { savedListAnalyticsRecorder: recorder }).savedListAnalyticsRecorder,
    ).toBe(recorder);
  });
  it("recovery stays disabled until old-writer retirement authority", async () => {
    const pool = { query: vi.fn(), connect: vi.fn() };
    const services = createCollectionsServices(pool as never);
    await expect(
      services.recovery.list(
        {},
        {
          tenantId: "tnt_test" as never,
          audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_test" as never },
        },
      ),
    ).rejects.toMatchObject({ code: "disabled" });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
