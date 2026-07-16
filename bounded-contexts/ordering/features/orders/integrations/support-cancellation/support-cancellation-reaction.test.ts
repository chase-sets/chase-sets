import { describe, expect, it, vi } from "vitest";
import {
  buildOrderingSupportCancellationReactionHandlers,
  SUPPORT_CANCEL_ORDER_REASON,
} from "./support-cancellation-reaction";

function resolvedEvent(resolutionType: string) {
  return {
    tenantId: "tnt_test",
    streamId: "support.support-request-sup_1",
    streamVersion: 4,
    eventId: "evt_1",
    globalPosition: "1",
    type: "support.support-request.resolved",
    data: {
      supportRequestId: "sup_1",
      orderId: "ord_1",
      resolution: {
        resolutionType,
        refundAmount: null,
        summary: "Buyer cancellation.",
        resolvedAt: "2026-06-01T12:00:00.000Z",
      },
    },
    timing: { occurredAt: "2026-06-01T12:00:00.000Z", recordedAt: "2026-06-01T12:00:00.000Z" },
    audit: { performedByUserId: "usr_agent", forAccountId: "acc_buyer" },
    trace: null,
  } as never;
}

describe("ordering support cancellation reaction", () => {
  it("dispatches CancelOrder for a cancel-order resolution", async () => {
    const dispatch = vi.fn(async () => ({ version: 5 }));
    const handlers = buildOrderingSupportCancellationReactionHandlers(dispatch);

    await handlers["support.support-request.resolved"]?.(resolvedEvent("cancel-order"));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "ordering.order-ord_1",
        command: {
          type: "CancelOrder",
          cancelledAt: "2026-06-01T12:00:00.000Z",
          reason: SUPPORT_CANCEL_ORDER_REASON,
        },
        context: expect.objectContaining({ tenantId: "tnt_test" }),
      }),
    );
  });

  it.each(["full-refund", "partial-refund", "return-for-refund", "replacement", "no-action", "support-reviewed"])(
    "ignores a %s resolution",
    async (resolutionType) => {
      const dispatch = vi.fn(async () => ({ version: 5 }));
      const handlers = buildOrderingSupportCancellationReactionHandlers(dispatch);

      await handlers["support.support-request.resolved"]?.(resolvedEvent(resolutionType));

      expect(dispatch).not.toHaveBeenCalled();
    },
  );
});
