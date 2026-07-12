import { describe, expect, it, vi } from "vitest";
import { buildFoundersWindowReactionHandlers, foundersWindowAgreementId } from "./founders-window-reaction";

describe("founders window agreement reaction", () => {
  it("creates one deterministic zero-percent agreement anchored to beta access", async () => {
    const createAgreement = vi.fn().mockResolvedValue({ agreementId: "cag_1", version: 1 });
    const handlers = buildFoundersWindowReactionHandlers({ createAgreement } as never);
    await handlers["identity.account.founders-window-opened"]!({
      streamId: "identity.account-acc_01ABC",
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_admin", forAccountId: "acc_01ABC" },
      trace: {},
      timing: { occurredAt: "2026-07-01T00:00:00.000Z", recordedAt: "2026-07-01T00:00:01.000Z" },
      data: {
        betaAccessStartedAt: "2026-07-01T00:00:00.000Z",
        foundersWindowEndsAt: "2026-08-30T00:00:00.000Z",
      },
    } as never);

    expect(foundersWindowAgreementId("acc_01ABC")).toBe("cag_fnd_01ABC");
    expect(createAgreement).toHaveBeenCalledWith(
      expect.objectContaining({
        agreementId: "cag_fnd_01ABC",
        accountId: "acc_01ABC",
        marketplaceSalesFeePercentageBps: 0,
        marketplaceSalesFeeFixedAmount: "0.00",
        effectiveFrom: "2026-07-01T00:00:00.000Z",
        effectiveUntil: "2026-08-30T00:00:00.000Z",
      }),
      expect.any(Object),
    );
  });
});
