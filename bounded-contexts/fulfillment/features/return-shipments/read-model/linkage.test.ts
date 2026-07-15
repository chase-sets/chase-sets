import { describe, expect, it, vi } from "vitest";
import {
  loadReturnShipmentLinkageSource,
  validateReturnShipmentLinkage,
  type ReturnShipmentLinkageSource,
} from "./linkage";

const source: ReturnShipmentLinkageSource = {
  supportOrderId: "ord_1",
  supportAffectedOrderLineIds: ["oli_1", "oli_2"],
  remedySupportRequestId: "sup_1",
  remedyReturnDirective: "return-to-platform",
  shipmentOrderId: "ord_1",
  shipmentOrderLineIds: ["oli_1", "oli_2", "oli_3"],
};

const linkage = {
  supportRequestId: "sup_1",
  remedyId: "rmd_1",
  orderId: "ord_1",
  outboundShipmentId: "shp_1",
  affectedOrderLineIds: ["oli_1", "oli_2"],
  returnDirective: "return-to-platform",
} as const;

describe("ReturnShipment source linkage", () => {
  it("accepts an exact support-case/order linkage whose lines belong to the outbound shipment", () => {
    expect(validateReturnShipmentLinkage(linkage, source)).toEqual({ ok: true });
  });

  it.each([
    ["case order", { ...source, supportOrderId: "ord_other" }],
    ["remedy case", { ...source, remedySupportRequestId: "sup_other" }],
    ["remedy directive", { ...source, remedyReturnDirective: "return-to-seller" }],
    ["shipment order", { ...source, shipmentOrderId: "ord_other" }],
    ["case lines", { ...source, supportAffectedOrderLineIds: ["oli_1"] }],
    ["shipment lines", { ...source, shipmentOrderLineIds: ["oli_1"] }],
  ])("rejects mismatched %s linkage", (_label, mismatch) => {
    expect(validateReturnShipmentLinkage(linkage, mismatch)).toMatchObject({ ok: false });
  });

  it("loads Support-owned and Fulfillment-owned linkage from local projections", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            support_order_id: "ord_1",
            support_affected_order_line_ids: ["oli_1", "oli_2"],
            remedy_support_request_id: "sup_1",
            remedy_return_directive: "return-to-platform",
            shipment_order_id: "ord_1",
            shipment_order_line_ids: ["oli_1", "oli_2", "oli_3"],
          },
        ],
      })),
    };

    await expect(loadReturnShipmentLinkageSource(db as never, linkage)).resolves.toEqual(source);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("fulfillment_support_return_sources"), [
      "sup_1",
      "rmd_1",
      "shp_1",
    ]);
  });
});
