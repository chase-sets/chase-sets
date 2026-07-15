import { describe, expect, it, vi } from "vitest";
import type { EnqueueNotificationInput, NotificationMessage } from "@chase-sets/outbound-messaging";
import {
  createInMemorySupportCaseDirectory,
  projectSettlementSupportHoldFactToNotification,
  projectSupportDisputeEventToNotification,
  SUPPORT_DISPUTE_NOTIFICATION_MATRIX,
  SUPPORT_DISPUTE_NOTIFYING_EVENT_TYPES,
  SUPPORT_REQUEST_LIFECYCLE_EVENT_TYPES,
  type SupportCaseRouting,
} from "./support-dispute-notifications";

const PROJECTION = "notifications-source-facts-outbox-projection";

const baseEvent = {
  id: "evt_1",
  tenantId: "tnt_1",
  streamId: "stream_1",
  streamVersion: 1,
  globalPosition: "10" as never,
  trace: { traceId: "trace_1" },
  audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
  timing: { occurredAt: "2026-07-14T00:00:00.000Z" as never, recordedAt: "2026-07-14T00:00:00.000Z" as never },
  metadata: {},
} as const;

const routing: SupportCaseRouting = {
  supportRequestId: "sup_1",
  orderId: "ord_1",
  buyerAccountId: "acc_buyer" as never,
  sellerAccountId: "acc_seller" as never,
  flowType: "item-not-received",
  sellerResponseDueAt: "2026-07-16T00:00:00.000Z",
};

function createCapturingOutbox() {
  const enqueued: NotificationMessage[] = [];
  return {
    enqueued,
    outbox: {
      enqueueNotification: vi.fn(async (input: EnqueueNotificationInput) => {
        enqueued.push(input.message);
      }),
    },
  };
}

async function projectSupport(
  eventType: string,
  data: unknown,
  directory = createInMemorySupportCaseDirectory([routing]),
) {
  const { enqueued, outbox } = createCapturingOutbox();
  await projectSupportDisputeEventToNotification(
    outbox,
    directory,
    { ...baseEvent, type: eventType, data } as never,
    PROJECTION,
  );
  return { enqueued, outbox };
}

describe("dispute notification matrix — completeness", () => {
  it("classifies every support-request lifecycle event with no gaps or extras", () => {
    const matrixKeys = Object.keys(SUPPORT_DISPUTE_NOTIFICATION_MATRIX).sort();
    const catalog = [...SUPPORT_REQUEST_LIFECYCLE_EVENT_TYPES].sort();
    expect(matrixKeys).toEqual(catalog);
  });

  it("keeps the notifying-event list in sync with the notify decisions in the matrix", () => {
    const notifyFromMatrix = SUPPORT_REQUEST_LIFECYCLE_EVENT_TYPES.filter(
      (eventType) => SUPPORT_DISPUTE_NOTIFICATION_MATRIX[eventType].kind === "notify",
    ).sort();
    expect([...SUPPORT_DISPUTE_NOTIFYING_EVENT_TYPES].sort()).toEqual(notifyFromMatrix);
  });

  it("gives every internal decision a documented reason", () => {
    for (const decision of Object.values(SUPPORT_DISPUTE_NOTIFICATION_MATRIX)) {
      if (decision.kind === "internal") {
        expect(decision.reason.length).toBeGreaterThan(0);
      } else {
        expect(decision.audience).toBeTruthy();
      }
    }
  });
});

describe("case opened", () => {
  it("notifies the seller with the response deadline and the buyer with a no-action confirmation", async () => {
    const directory = createInMemorySupportCaseDirectory();
    const { enqueued } = await projectSupport(
      "support.support-request.opened",
      {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        flowType: "item-not-received",
        openedAt: "2026-07-14T00:00:00.000Z",
        sellerResponseDueAt: "2026-07-16T00:00:00.000Z",
      },
      directory,
    );

    expect(enqueued).toHaveLength(2);
    const seller = enqueued.find((m) => m.recipientAccountId === "acc_seller")!;
    const buyer = enqueued.find((m) => m.recipientAccountId === "acc_buyer")!;
    expect(seller.channels).toEqual([
      { channel: "web", recipient: { accountId: "acc_seller" }, actionHref: "/account/support/sup_1" },
    ]);
    expect(seller.body).toContain("2026-07-16T00:00:00.000Z");
    expect(seller.actionHref).toBe("/account/support/sup_1");
    expect(buyer.body.toLowerCase()).toContain("no action");
    // Opening the case records routing so mid-lifecycle events can be routed later.
    expect(await directory.lookupCase("sup_1")).toMatchObject({ sellerAccountId: "acc_seller" });
  });
});

describe("response and offer routing", () => {
  it("routes a plain seller response to the buyer counterparty", async () => {
    const { enqueued } = await projectSupport("support.support-request.response-recorded", {
      supportRequestId: "sup_1",
      response: { responseId: "res_1", submittedByRole: "seller", offerId: null },
      offer: null,
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.recipientAccountId).toBe("acc_buyer");
  });

  it("routes an offer to the party who must respond to it", async () => {
    const { enqueued } = await projectSupport("support.support-request.response-recorded", {
      supportRequestId: "sup_1",
      response: { responseId: "res_1", submittedByRole: "seller", offerId: "off_1" },
      offer: {
        offerId: "off_1",
        offeredByRole: "seller",
        pendingWithRole: "buyer",
        resolutionType: "partial-refund",
        refundAmount: "5.00",
      },
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.recipientAccountId).toBe("acc_buyer");
    expect(enqueued[0]!.body).toContain("partial refund");
  });

  it("notifies the proposer when their offer is declined", async () => {
    const { enqueued } = await projectSupport("support.support-request.offer-declined", {
      supportRequestId: "sup_1",
      offer: { offerId: "off_1", offeredByRole: "seller", resolutionType: "partial-refund" },
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.recipientAccountId).toBe("acc_seller");
  });
});

describe("escalation and resolution", () => {
  it("notifies both parties on escalation with no-action copy", async () => {
    const { enqueued } = await projectSupport("support.support-request.escalated", {
      supportRequestId: "sup_1",
      escalatedAt: "2026-07-15T00:00:00.000Z",
      reason: "buyer requested review",
    });
    expect(enqueued.map((m) => m.recipientAccountId).sort()).toEqual(["acc_buyer", "acc_seller"]);
    for (const message of enqueued) expect(message.body.toLowerCase()).toContain("no action");
  });

  it("states an adjudicated resolution is binding and reaches both parties", async () => {
    const { enqueued } = await projectSupport("support.support-request.resolved", {
      supportRequestId: "sup_1",
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      flowType: "item-not-received",
      resolution: {
        resolutionType: "full-refund",
        resolvedAt: "2026-07-15T00:00:00.000Z",
        refundAmount: "20.00",
        evidenceBasis: { type: "operator-finding", reference: "case-review-1" },
      },
    });
    expect(enqueued.map((m) => m.recipientAccountId).sort()).toEqual(["acc_buyer", "acc_seller"]);
    for (const message of enqueued) expect(message.body.toLowerCase()).toContain("binding");
  });

  it("uses agreement copy when both parties accepted, without claiming it is binding", async () => {
    const { enqueued } = await projectSupport("support.support-request.resolved", {
      supportRequestId: "sup_1",
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      flowType: "item-not-received",
      resolution: {
        resolutionType: "partial-refund",
        resolvedAt: "2026-07-15T00:00:00.000Z",
        refundAmount: "5.00",
        evidenceBasis: { type: "party-accepted-resolution", reference: "off_1" },
      },
    });
    expect(enqueued[0]!.body.toLowerCase()).not.toContain("binding");
    expect(enqueued[0]!.body.toLowerCase()).toContain("agreed");
  });

  it("tells both parties when the deadline applied an automatic outcome", async () => {
    const { enqueued } = await projectSupport("support.support-request.resolved", {
      supportRequestId: "sup_1",
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      flowType: "item-not-received",
      resolution: {
        resolutionType: "full-refund",
        resolvedAt: "2026-07-16T00:00:00.000Z",
        refundAmount: "20.00",
        evidenceBasis: {
          type: "deterministic-policy",
          reference: "support-policy.seller-response-deadline.v1",
        },
      },
    });

    expect(enqueued.map((message) => message.recipientAccountId).sort()).toEqual(["acc_buyer", "acc_seller"]);
    for (const message of enqueued) {
      expect(message.body.toLowerCase()).toContain("resolved automatically");
      expect(message.body.toLowerCase()).toContain("full refund");
      expect(message.actionHref).toBe("/account/support/sup_1");
    }
  });
});

describe("return flow and reminders", () => {
  it("notifies the seller to inspect a delivered return", async () => {
    const { enqueued } = await projectSupport("support.support-request.return-delivered", {
      supportRequestId: "sup_1",
      deliveredAt: "2026-07-15T00:00:00.000Z",
      returnRefundReleaseDueAt: "2026-07-18T00:00:00.000Z",
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.recipientAccountId).toBe("acc_seller");
    expect(enqueued[0]!.body).toContain("2026-07-18T00:00:00.000Z");
  });

  it("reminds only the party whose response is due and states the automatic consequence", async () => {
    const { enqueued } = await projectSupport("support.support-request.response-reminder-emitted", {
      supportRequestId: "sup_1",
      remindedAt: "2026-07-15T00:00:00.000Z",
      actingRole: "seller",
      dueAt: "2026-07-16T00:00:00.000Z",
      deadlineOutcome: { type: "automatic-resolution", resolutionType: "full-refund" },
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.recipientAccountId).toBe("acc_seller");
    expect(enqueued[0]!.body).toContain("2026-07-16T00:00:00.000Z");
    expect(enqueued[0]!.body.toLowerCase()).toContain("full refund");
    expect(enqueued[0]!.body.toLowerCase()).toContain("automatically");
  });

  it("states support review as the silence consequence when automatic resolution is unsafe", async () => {
    const { enqueued } = await projectSupport("support.support-request.response-reminder-emitted", {
      supportRequestId: "sup_1",
      remindedAt: "2026-07-15T00:00:00.000Z",
      actingRole: "seller",
      dueAt: "2026-07-16T00:00:00.000Z",
      deadlineOutcome: { type: "support-review" },
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.body.toLowerCase()).toContain("support review");
  });

  it("keeps support-review reminders out of buyer and seller feeds", async () => {
    const { enqueued } = await projectSupport("support.support-request.review-reminder-emitted", {
      supportRequestId: "sup_1",
      remindedAt: "2026-07-15T00:00:00.000Z",
      dueAt: "2026-07-16T00:00:00.000Z",
    });

    expect(enqueued).toHaveLength(0);
  });

  it("skips notification when the case routing is unknown", async () => {
    const { enqueued } = await projectSupport(
      "support.support-request.escalated",
      { supportRequestId: "sup_unknown", escalatedAt: "2026-07-15T00:00:00.000Z", reason: "x" },
      createInMemorySupportCaseDirectory(),
    );
    expect(enqueued).toHaveLength(0);
  });
});

describe("settlement support-hold facts — released vs consumed", () => {
  const holdBase = {
    holdId: "hold_1",
    supportRequestId: "sup_1",
    orderId: "ord_1",
    buyerAccountId: "acc_buyer",
    sellerAccountId: "acc_seller",
    flowType: "item-not-received",
    occurredAt: "2026-07-15T00:00:00.000Z",
  };

  async function projectHold(eventType: string, data: unknown) {
    const { enqueued, outbox } = createCapturingOutbox();
    await projectSettlementSupportHoldFactToNotification(
      outbox,
      { ...baseEvent, type: eventType, data } as never,
      PROJECTION,
    );
    return enqueued;
  }

  it("tells the seller a placed hold is holding funds and links the case", async () => {
    const enqueued = await projectHold("settlement.support-hold.placed.v1", holdBase);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.recipientAccountId).toBe("acc_seller");
    expect(enqueued[0]!.actionHref).toBe("/account/support/sup_1");
  });

  it("says a released hold was returned to the seller", async () => {
    const enqueued = await projectHold("settlement.support-hold.released.v1", {
      ...holdBase,
      releaseReason: "support-closed",
    });
    expect(enqueued[0]!.body.toLowerCase()).toContain("released back to you");
  });

  it("never tells the seller consumed funds were released back to them", async () => {
    const enqueued = await projectHold("settlement.support-hold.consumed.v1", {
      ...holdBase,
      resolutionType: "full-refund",
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.recipientAccountId).toBe("acc_seller");
    expect(enqueued[0]!.body.toLowerCase()).not.toContain("released back");
    expect(enqueued[0]!.body).toContain("full refund");
  });
});

describe("idempotent delivery", () => {
  it("produces a stable idempotency key for the same transition and recipient", async () => {
    const first = await projectSupport("support.support-request.escalated", {
      supportRequestId: "sup_1",
      escalatedAt: "2026-07-15T00:00:00.000Z",
      reason: "review",
    });
    const second = await projectSupport("support.support-request.escalated", {
      supportRequestId: "sup_1",
      escalatedAt: "2026-07-15T00:00:00.000Z",
      reason: "review",
    });
    expect(first.enqueued.map((m) => m.idempotencyKey).sort()).toEqual(
      second.enqueued.map((m) => m.idempotencyKey).sort(),
    );
  });

  it("keys response reminders by case and deadline window rather than sweep attempt time", async () => {
    const reminder = {
      supportRequestId: "sup_1",
      actingRole: "seller",
      dueAt: "2026-07-16T00:00:00.000Z",
      deadlineOutcome: { type: "automatic-resolution", resolutionType: "full-refund" },
    };
    const first = await projectSupport("support.support-request.response-reminder-emitted", {
      ...reminder,
      remindedAt: "2026-07-15T00:00:00.000Z",
    });
    const retry = await projectSupport("support.support-request.response-reminder-emitted", {
      ...reminder,
      remindedAt: "2026-07-15T00:01:00.000Z",
    });

    expect(first.enqueued).toHaveLength(1);
    expect(retry.enqueued).toHaveLength(1);
    expect(first.enqueued[0]!.idempotencyKey).toBe(retry.enqueued[0]!.idempotencyKey);
    expect(first.enqueued[0]!.idempotencyKey).toContain("2026-07-16T00:00:00.000Z");
  });

  it("preserves the pre-outcome reminder key during historical event replay", async () => {
    const legacy = {
      supportRequestId: "sup_1",
      remindedAt: "2026-07-15T00:00:00.000Z",
      actingRole: "seller",
      dueAt: "2026-07-16T00:00:00.000Z",
    };
    const first = await projectSupport("support.support-request.response-reminder-emitted", legacy);
    const replay = await projectSupport("support.support-request.response-reminder-emitted", legacy);

    expect(first.enqueued[0]!.idempotencyKey).toBe(
      "notifications:support:response-reminder:sup_1:2026-07-15T00:00:00.000Z:acc_seller",
    );
    expect(replay.enqueued[0]!.idempotencyKey).toBe(first.enqueued[0]!.idempotencyKey);
  });
});
