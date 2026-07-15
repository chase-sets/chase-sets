import { describe, expect, it, vi } from "vitest";
import { buildSupportShipmentSourceProjectionHandlers } from "./source-projection";

describe("Support Fulfillment source reactions", () => {
  it("satisfies the facility-intake remedy effect from the immutable intake fact", async () => {
    const recordRemedyEffect = vi.fn(async () => ({ supportRequestId: "sup_1", remedyId: "rmd_1", version: 4 }));
    const handlers = buildSupportShipmentSourceProjectionHandlers(
      { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never,
      { recordRemedyEffect },
    );
    await handlers["fulfillment.return-shipment.facility-intake-completed.v1"]!({
      id: "evt_intake_1",
      type: "fulfillment.return-shipment.facility-intake-completed.v1",
      streamId: "fulfillment.return-shipment-rsh_1",
      streamVersion: 6,
      globalPosition: 10,
      tenantId: "tnt_1",
      data: {
        returnShipmentId: "rsh_1",
        remedyId: "rmd_1",
        supportRequestId: "sup_1",
        intake: {
          receivedAt: "2026-07-14T12:00:00.000Z",
          idempotencyKey: "intake-1",
        },
      },
      metadata: {},
      audit: { performedByUserId: "usr_operator", forAccountId: "acc_platform" },
      trace: {},
      timing: { occurredAt: "2026-07-14T12:00:00.000Z", recordedAt: "2026-07-14T12:00:00.000Z" },
    } as never);

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
});
