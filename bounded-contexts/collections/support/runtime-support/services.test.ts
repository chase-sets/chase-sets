import { describe, expect, it, vi } from "vitest";
import { createCollectionsServices } from "./services";

describe("Collections runtime-support composition", () => {
  it("preserves the Saved List analytics recorder identity", () => {
    const recorder = { record: vi.fn() };
    expect(
      createCollectionsServices({} as never, { savedListAnalyticsRecorder: recorder }).savedListAnalyticsRecorder,
    ).toBe(recorder);
  });
  it("recovery stays disabled while persisted activation is inactive", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ singleton: true, activated_at: null }] })),
      connect: vi.fn(),
    };
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
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("FROM collections_anonymous_owner_activation"));
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
