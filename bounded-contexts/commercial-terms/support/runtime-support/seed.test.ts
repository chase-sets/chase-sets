import { describe, expect, it, vi } from "vitest";
import { commercialTermsSeedIds } from "../seed-support/ids";
import type { createCommercialTermsServices } from "./services";
import { supersedeLegacyScheduleIfActive } from "./seed";

const context = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_support" as never,
    forAccountId: "acc_support" as never,
  },
};

describe("commercial terms schedule seed lifecycle", () => {
  it("supersedes an active legacy account-tier schedule through an additive revision", async () => {
    const value = {
      label: "Personal Default",
      accountType: "personal" as const,
      marketplaceSalesFeePercentageBps: 900,
      marketplaceSalesFeeFixedAmount: "0.15",
      shippingAllowancePercentageBps: 500,
    };
    const reviseScheduleDocument = vi.fn(async () => ({
      scheduleId: commercialTermsSeedIds.schedules.personalDefault,
      version: 2,
    }));
    const services = {
      db: {
        query: vi.fn(async () => ({
          rows: [
            {
              status: "active",
              value,
              effective_from: "2026-01-01T00:00:00.000Z",
              effective_until: null,
            },
          ],
        })),
      },
      policies: { reviseScheduleDocument },
    } as unknown as ReturnType<typeof createCommercialTermsServices>;

    await supersedeLegacyScheduleIfActive(services, context, {
      scheduleId: commercialTermsSeedIds.schedules.personalDefault,
      accountType: "personal",
    });

    expect(reviseScheduleDocument).toHaveBeenCalledWith(
      expect.objectContaining({ policyKey: "commercial-terms.schedule.personal" }),
      commercialTermsSeedIds.schedules.personalDefault,
      {
        value,
        status: "inactive",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: expect.any(String),
      },
      context,
    );
  });

  it("leaves an already superseded schedule unchanged", async () => {
    const reviseScheduleDocument = vi.fn();
    const services = {
      db: {
        query: vi.fn(async () => ({ rows: [{ status: "inactive" }] })),
      },
      policies: { reviseScheduleDocument },
    } as unknown as ReturnType<typeof createCommercialTermsServices>;

    await supersedeLegacyScheduleIfActive(services, context, {
      scheduleId: commercialTermsSeedIds.schedules.businessDefault,
      accountType: "business",
    });

    expect(reviseScheduleDocument).not.toHaveBeenCalled();
  });
});
