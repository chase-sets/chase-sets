import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createSupportReturnLabelWorkflow } from "./support-return-label-workflow";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_system" as never, forAccountId: "acc_buyer" as never },
};

function source() {
  return {
    supportRequestId: "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    orderId: "ord_1",
    outboundShipmentId: "shp_1",
    affectedOrderLineIds: ["oli_1"],
    buyerAccountId: "acc_buyer",
    sellerAccountId: "acc_seller",
    buyerAddress: {
      name: "Buyer",
      line1: "2 Buyer St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    sellerAddress: {
      name: "Seller",
      line1: "8 Seller St",
      city: "Madison",
      state: "WI",
      postalCode: "53703",
      country: "US",
    },
    packagePlan: {
      packages: [
        {
          mailpieceClass: "parcel" as const,
          lengthInches: 9,
          widthInches: 6,
          heightInches: 2,
          weightOunces: 10,
          serviceLevel: "standard-parcel" as const,
        },
      ],
    },
  };
}

describe("support return-label workflow", () => {
  it.each([
    ["product-damaged", "seller"],
    ["return-request", "buyer"],
  ] as const)("issues %s returns once with %s cost allocation", async (flowType, costPayer) => {
    const issueReturnLabel = vi.fn(async () => ({ outcome: "label-ready" as const }));
    const workflow = createSupportReturnLabelWorkflow({
      loadSource: vi.fn(async () => source()),
      issueReturnLabel: issueReturnLabel as never,
      voidReturnLabel: vi.fn() as never,
      now: () => "2026-07-15T12:00:00.000Z",
    });

    await workflow.issueForResolution(
      {
        supportRequestId: source().supportRequestId,
        flowType,
        resolution: { resolutionType: "return-for-refund", resolvedAt: "2026-07-15T12:00:00.000Z" },
      },
      context,
    );

    expect(issueReturnLabel).toHaveBeenCalledTimes(1);
    expect(issueReturnLabel.mock.calls[0]![0]).toMatchObject({
      returnShipmentId: "rsh_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      remedyId: "rmd_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      returnDirective: "return-to-seller",
      costPayer,
      shipFromSnapshot: { city: "Chicago" },
      destinationSnapshot: { destinationType: "seller", sellerAccountId: "acc_seller" },
      packageRequirements: { lengthInches: 9, widthInches: 6, heightInches: 2, weightOunces: 10 },
      idempotencyKey: "support-return-label:sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    });
  });

  it("ignores resolutions that do not require a return", async () => {
    const issueReturnLabel = vi.fn();
    const workflow = createSupportReturnLabelWorkflow({
      loadSource: vi.fn(async () => source()),
      issueReturnLabel: issueReturnLabel as never,
      voidReturnLabel: vi.fn() as never,
    });
    expect(
      await workflow.issueForResolution(
        {
          supportRequestId: source().supportRequestId,
          flowType: "product-damaged",
          resolution: { resolutionType: "full-refund", resolvedAt: "2026-07-15T12:00:00.000Z" },
        },
        context,
      ),
    ).toEqual({ outcome: "not-return-bearing" });
    expect(issueReturnLabel).not.toHaveBeenCalled();
  });

  it("voids the stable unused label when its support case is cancelled", async () => {
    const voidReturnLabel = vi.fn(async () => ({ outcome: "voided" as const }));
    const workflow = createSupportReturnLabelWorkflow({
      loadSource: vi.fn(async () => source()),
      issueReturnLabel: vi.fn() as never,
      voidReturnLabel: voidReturnLabel as never,
    });
    await workflow.voidForCancellation(
      { supportRequestId: source().supportRequestId, reason: "Case cancelled" },
      context,
    );
    expect(voidReturnLabel).toHaveBeenCalledWith(
      {
        returnShipmentId: "rsh_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
        reason: "Case cancelled",
      },
      context,
    );
  });
});
