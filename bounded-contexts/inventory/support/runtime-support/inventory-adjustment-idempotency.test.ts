import { describe, expect, it, vi } from "vitest";
import {
  completeInventoryAdjustmentIdempotency,
  inventoryAdjustmentCommandFingerprint,
} from "./inventory-adjustment-idempotency";

const baseInput = {
  accountId: "acc_seller",
  itemId: "inv_1",
  quantityDelta: 3,
  reason: "Import quantity adjustment",
  sourceRef: null,
} as const;

describe("inventory adjustment idempotency", () => {
  it("keeps legacy adjustment fingerprints byte-identical when sale fields are absent", () => {
    expect(inventoryAdjustmentCommandFingerprint(baseInput)).toBe(
      "5b7e79c784d1004f25875df18baab87cdf8f6060fe537fa10effd644cfc931bb",
    );
    expect(
      inventoryAdjustmentCommandFingerprint({
        ...baseInput,
        reasonCode: "intake",
        note: "  Received at counter  ",
      }),
    ).toBe("b4e204c1c02147fe9d06473d002e86c17f75808b9c19d4c80331c744dbff7862");
  });

  it("fingerprints normalized price, channel, and effective collision mode", () => {
    const omittedMode = inventoryAdjustmentCommandFingerprint({
      ...baseInput,
      quantityDelta: -3,
      reason: "Offline sale",
      reasonCode: "sold-offline",
      salePriceAmount: "125.00",
      channel: "in-store",
    });
    expect(
      inventoryAdjustmentCommandFingerprint({
        ...baseInput,
        quantityDelta: -3,
        reason: "Offline sale",
        reasonCode: "sold-offline",
        salePriceAmount: "125.00",
        channel: "in-store",
        collisionMode: "protect-orders",
      }),
    ).toBe(omittedMode);
    expect(
      inventoryAdjustmentCommandFingerprint({
        ...baseInput,
        quantityDelta: -3,
        reason: "Offline sale",
        reasonCode: "sold-offline",
        salePriceAmount: "126.00",
        channel: "in-store",
      }),
    ).not.toBe(omittedMode);
    expect(
      inventoryAdjustmentCommandFingerprint({
        ...baseInput,
        quantityDelta: -3,
        reason: "Offline sale",
        reasonCode: "sold-offline",
        salePriceAmount: "125.00",
        channel: "card-show",
      }),
    ).not.toBe(omittedMode);
    expect(
      inventoryAdjustmentCommandFingerprint({
        ...baseInput,
        quantityDelta: -3,
        reason: "Offline sale",
        reasonCode: "sold-offline",
        salePriceAmount: "125.00",
        channel: "in-store",
        collisionMode: "honor-offline",
      }),
    ).not.toBe(omittedMode);
  });

  it("guards completion by in-progress status and the claimed fingerprint", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));

    await expect(
      completeInventoryAdjustmentIdempotency({ query } as never, {
        idempotencyKey: "sale-1",
        commandFingerprint: "fingerprint-a",
        resultItemId: "inv_1",
        resultVersion: 2,
        resultCollision: null,
      }),
    ).resolves.toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/status = 'in_progress'[\s\S]*command_fingerprint = \$2/),
      ["sale-1", "fingerprint-a", "inv_1", 2, "null"],
    );
  });
});
