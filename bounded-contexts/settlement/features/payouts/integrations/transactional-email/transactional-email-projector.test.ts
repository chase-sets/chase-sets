import { describe, expect, it, vi } from "vitest";
import { buildSettlementPayoutTransactionalEmailProjectionHandlers } from "./transactional-email-projector";

async function projectSettlementPayoutEventToTransactionalEmail(
  outbox: Parameters<typeof buildSettlementPayoutTransactionalEmailProjectionHandlers>[0],
  event: never,
) {
  const handlers = buildSettlementPayoutTransactionalEmailProjectionHandlers(outbox);
  await handlers[(event as { type: string }).type]?.(event);
}

describe("settlement transactional email projector", () => {
  it("enqueues when payout.completed events include a notification email", async () => {
    const outbox = { enqueueNotification: vi.fn(async () => undefined) };
    await projectSettlementPayoutEventToTransactionalEmail(outbox, {
      id: "evt_4",
      type: "settlement.payout.completed",
      globalPosition: "4",
      trace: { traceId: "req_4" },
      timing: {
        occurredAt: "2026-04-02T00:00:00.000Z",
        recordedAt: "2026-04-02T00:00:01.000Z",
      },
      data: {
        notificationEmail: "seller@example.com",
        payoutId: "po_1",
        amount: "42.00",
      },
    } as never);
    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
  });
});
