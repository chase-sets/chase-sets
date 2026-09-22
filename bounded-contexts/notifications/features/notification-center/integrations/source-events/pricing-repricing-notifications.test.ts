import { describe, expect, it, vi } from "vitest";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  buildNotificationsPricingRepricingProjectionHandlers,
  mapRepricingDigestToNotification,
} from "./pricing-repricing-notifications";

const data = {
  schemaVersion: 1 as const,
  digestId: "acc_a-2026-09-20",
  sellerAccountId: "acc_a",
  day: "2026-09-20",
  policiesEvaluated: 2,
  listingsChanged: 3,
  floorClamped: 4,
  ceilingClamped: 5,
  maxMoveClamped: 6,
  budgetExhausted: 7,
  pausedForMissingInput: 8,
  withinTolerance: 9,
  spiralBreakerTrips: 10,
};
const event = {
  id: "evt_digest",
  tenantId: "tnt_identity",
  globalPosition: "104",
  trace: { traceId: "trace_digest" },
  timing: { occurredAt: "2026-09-21T00:10:00.000Z" },
  type: "pricing.repricing-activity.digest-requested",
  data,
} as unknown as TransportEvent & { data: typeof data };

describe("Pricing repricing digest notification mapping", () => {
  it("maps one operational count-only message with exact source identity and the seller's deep link", async () => {
    const enqueueNotification = vi.fn().mockResolvedValue(undefined);
    const outbox = { enqueueNotification } as unknown as NotificationOutbox;
    const handlers = buildNotificationsPricingRepricingProjectionHandlers(outbox);
    expect(Object.keys(handlers)).toEqual([event.type]);
    await handlers[event.type]!(event);
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueNotification).toHaveBeenCalledWith({
      message: expect.objectContaining({
        category: "operational",
        criticality: "operational",
        recipientAccountId: "acc_a",
        templateId: "pricing_repricing_activity_digest",
        templateVersion: 1,
        actionHref: "/account/desk/repricing",
        idempotencyKey: "notifications:pricing:repricing-digest:acc_a-2026-09-20",
        title: "Repricing activity for 2026-09-20",
        body: "2 policies evaluated; 3 listing changes; 4 floor clamps; 5 ceiling clamps; 6 maximum-move clamps; 7 budget limits; 8 pauses for missing input; 9 within tolerance; 10 spiral breaker trips.",
        templateData: {
          digestId: data.digestId,
          day: data.day,
          policiesEvaluated: 2,
          listingsChanged: 3,
          floorClamped: 4,
          ceilingClamped: 5,
          maxMoveClamped: 6,
          budgetExhausted: 7,
          pausedForMissingInput: 8,
          withinTolerance: 9,
          spiralBreakerTrips: 10,
          actionHref: "/account/desk/repricing",
        },
        channels: [{ channel: "web", recipient: { accountId: "acc_a" }, actionHref: "/account/desk/repricing" }],
      }),
      source: {
        sourceEventId: "evt_digest",
        sourceGlobalPosition: "104",
        projectionName: "notifications-source-facts-outbox-projection",
        occurredAt: "2026-09-21T00:10:00.000Z",
      },
    });
    expect(
      mapRepricingDigestToNotification({
        ...event,
        data: { ...data, sellerAccountId: "acc_b", digestId: "acc_b-2026-09-20" },
      }),
    ).toMatchObject({
      recipientAccountId: "acc_b",
      idempotencyKey: "notifications:pricing:repricing-digest:acc_b-2026-09-20",
    });
  });
  it("ignores extra source content and keeps replay identity stable without subscribing to individual evaluations", () => {
    const message = mapRepricingDigestToNotification({
      ...event,
      data: { ...data, ...{ listings: ["private-listing"], price: "12.00" } },
    });
    expect(JSON.stringify(message)).not.toContain("private-listing");
    expect(JSON.stringify(message)).not.toContain("12.00");
    expect(message).toEqual(mapRepricingDigestToNotification(event));
  });
});
