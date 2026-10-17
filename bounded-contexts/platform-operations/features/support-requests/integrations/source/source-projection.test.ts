import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildSupportShipmentSourceProjectionHandlers } from "./source-projection";

describe("Support Fulfillment source reactions", () => {
  it("satisfies the facility-intake remedy effect from the immutable intake fact", async () => {
    const recordRemedyEffect = vi.fn(async () => ({ supportRequestId: "sup_1", remedyId: "rmd_1", version: 4 }));
    const handlers = buildSupportShipmentSourceProjectionHandlers(
      { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never,
      { recordRemedyEffect },
    );
    await handlers["fulfillment.return-shipment.facility-intake-completed.v1"]!(
      buildTransportEvent(
        "fulfillment.return-shipment.facility-intake-completed.v1",
        {
          returnShipmentId: "rsh_1",
          remedyId: "rmd_1",
          supportRequestId: "sup_1",
          intake: {
            receivedAt: "2026-07-14T12:00:00.000Z",
            idempotencyKey: "intake-1",
          },
        },
        {
          id: "evt_intake_1",
          streamId: "fulfillment.return-shipment-rsh_1",
          streamVersion: 6,
          globalPosition: "10",
          tenantId: "tnt_1",
          audit: { performedByUserId: "usr_operator", forAccountId: "acc_platform" },
          trace: {},
        },
      ),
    );

    expect(recordRemedyEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        supportRequestId: "sup_1",
        remedyId: "rmd_1",
        effect: "facility-intake",
        outcome: "satisfied",
        sourceFactId: "evt_intake_1",
        idempotencyKey: "intake-1",
      }),
      expect.objectContaining({ tenantId: "tnt_1" }),
    );
  });

  function trackingEvent(type: string, extra: Record<string, unknown>) {
    return buildTransportEvent(
      type,
      {
        returnShipmentId: "rsh_1",
        remedyId: "rmd_1",
        supportRequestId: "sup_1",
        detail: null,
        metadata: {
          correlationRemedyId: "rmd_1",
          idempotencyKey: `${type}-idem`,
          policyVersion: "v1",
          causationId: null,
        },
        ...extra,
      },
      {
        id: `evt_${type}`,
        streamId: "fulfillment.return-shipment-rsh_1",
        streamVersion: 3,
        globalPosition: "5",
        tenantId: "tnt_1",
        audit: { performedByUserId: "usr_system", forAccountId: "acc_platform" },
        trace: {},
      },
    );
  }

  it("releases the refund by recording the delivered effect when delivered is the authorized trigger", async () => {
    const recordRemedyEffect = vi.fn(async () => ({ supportRequestId: "sup_1", remedyId: "rmd_1", version: 4 }));
    const query = vi.fn(async () => ({ rows: [{ refund_trigger: "delivered" }], rowCount: 1 }));
    const handlers = buildSupportShipmentSourceProjectionHandlers({ query } as never, { recordRemedyEffect });
    await handlers["fulfillment.return-shipment.delivered.v1"]!(
      trackingEvent("fulfillment.return-shipment.delivered.v1", { deliveredAt: "2026-07-14T12:00:00.000Z" }),
    );
    expect(recordRemedyEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        supportRequestId: "sup_1",
        remedyId: "rmd_1",
        effect: "return-delivered",
        outcome: "satisfied",
        idempotencyKey: "fulfillment.return-shipment.delivered.v1-idem",
      }),
      expect.objectContaining({ tenantId: "tnt_1" }),
    );
  });

  it("records the carrier-accepted effect only when carrier-accepted is the authorized trigger", async () => {
    const recordRemedyEffect = vi.fn(async () => ({ supportRequestId: "sup_1", remedyId: "rmd_1", version: 4 }));
    const query = vi.fn(async () => ({ rows: [{ refund_trigger: "carrier-accepted" }], rowCount: 1 }));
    const handlers = buildSupportShipmentSourceProjectionHandlers({ query } as never, { recordRemedyEffect });
    await handlers["fulfillment.return-shipment.carrier-accepted.v1"]!(
      trackingEvent("fulfillment.return-shipment.carrier-accepted.v1", { occurredAt: "2026-07-14T12:00:00.000Z" }),
    );
    expect(recordRemedyEffect).toHaveBeenCalledWith(
      expect.objectContaining({ effect: "carrier-accepted", outcome: "satisfied" }),
      expect.anything(),
    );
  });

  it("does not treat a delivered scan as a trigger when the authorized trigger is facility-intake", async () => {
    const recordRemedyEffect = vi.fn(async () => ({ supportRequestId: "sup_1", remedyId: "rmd_1", version: 4 }));
    const query = vi.fn(async () => ({ rows: [{ refund_trigger: "facility-intake" }], rowCount: 1 }));
    const handlers = buildSupportShipmentSourceProjectionHandlers({ query } as never, { recordRemedyEffect });
    await handlers["fulfillment.return-shipment.delivered.v1"]!(
      trackingEvent("fulfillment.return-shipment.delivered.v1", { deliveredAt: "2026-07-14T12:00:00.000Z" }),
    );
    expect(recordRemedyEffect).not.toHaveBeenCalled();
  });
});
