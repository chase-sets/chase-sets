import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildReviewHoldReactionHandlers } from "./review-hold-reaction";

function event(type: string, data: Record<string, unknown>) {
  return buildTransportEvent(type, data, {
    id: `evt_${type}`,
    streamId: "support.request-sup_1",
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
    timing: { occurredAt: "2026-07-01T00:00:00.000Z", recordedAt: "2026-07-01T00:00:00.000Z" },
  });
}

describe("review hold support reaction", () => {
  it("dispatches opened, resolved, and cancelled facts through Marketplace commands", async () => {
    const recordSupportRequestOpened = vi.fn(async () => undefined);
    const recordSupportRequestTerminal = vi.fn(async () => undefined);
    const handlers = buildReviewHoldReactionHandlers({ recordSupportRequestOpened, recordSupportRequestTerminal });

    await handlers["support.support-request.opened"]?.(
      event("support.support-request.opened", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        openedAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    await handlers["support.support-request.resolved"]?.(
      event("support.support-request.resolved", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        resolution: { resolvedAt: "2026-07-02T00:00:00.000Z" },
      }),
    );
    await handlers["support.support-request.cancelled"]?.(
      event("support.support-request.cancelled", {
        supportRequestId: "sup_2",
        orderId: "ord_1",
        cancelledAt: "2026-07-03T00:00:00.000Z",
      }),
    );

    expect(recordSupportRequestOpened).toHaveBeenCalledWith(
      {
        orderId: "ord_1",
        supportRequestId: "sup_1",
        openedAt: "2026-07-01T00:00:00.000Z",
      },
      expect.objectContaining({ tenantId: "tnt_1" }),
    );
    expect(recordSupportRequestTerminal).toHaveBeenNthCalledWith(
      1,
      {
        orderId: "ord_1",
        supportRequestId: "sup_1",
        terminalAt: "2026-07-02T00:00:00.000Z",
        terminalStatus: "resolved",
      },
      expect.any(Object),
    );
    expect(recordSupportRequestTerminal).toHaveBeenNthCalledWith(
      2,
      {
        orderId: "ord_1",
        supportRequestId: "sup_2",
        terminalAt: "2026-07-03T00:00:00.000Z",
        terminalStatus: "cancelled",
      },
      expect.any(Object),
    );
  });
});
