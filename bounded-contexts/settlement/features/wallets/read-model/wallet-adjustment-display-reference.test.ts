import { describe, expect, it, vi } from "vitest";
import type { WalletAdjustmentId } from "@chase-sets/primitives/typed-ids";
import {
  SETTLEMENT_WALLET_ADJUSTMENT_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT,
  withWalletAdjustmentDisplayReference,
} from "./wallet-adjustment-display-reference";

const adjustmentId = "wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9" as WalletAdjustmentId;

function uniqueViolation() {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint: SETTLEMENT_WALLET_ADJUSTMENT_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT,
  });
}

describe("withWalletAdjustmentDisplayReference", () => {
  it("resolves the base 8-char reference when there is no collision", async () => {
    const insert = vi.fn(async (displayReference: string) => displayReference);

    const result = await withWalletAdjustmentDisplayReference(adjustmentId, insert);

    expect(result).toBe("WAD-E6K7M8N9");
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("lengthens the suffix on a display-reference unique-index collision", async () => {
    const insert = vi
      .fn<(displayReference: string) => Promise<string>>()
      .mockRejectedValueOnce(uniqueViolation())
      .mockImplementationOnce(async (displayReference) => displayReference);

    const result = await withWalletAdjustmentDisplayReference(adjustmentId, insert);

    expect(result).toBe("WAD-N5E6K7M8N9");
    expect(insert).toHaveBeenNthCalledWith(1, "WAD-E6K7M8N9");
    expect(insert).toHaveBeenNthCalledWith(2, "WAD-N5E6K7M8N9");
  });

  it("retries through 12 chars before giving up", async () => {
    const insert = vi.fn(async () => {
      throw uniqueViolation();
    });

    await expect(withWalletAdjustmentDisplayReference(adjustmentId, insert)).rejects.toMatchObject({
      code: "23505",
      constraint: SETTLEMENT_WALLET_ADJUSTMENT_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT,
    });
    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert).toHaveBeenNthCalledWith(3, "WAD-Z5N5E6K7M8N9");
  });

  it("propagates non-collision errors immediately without retrying", async () => {
    const unrelatedError = new Error("connection reset");
    const insert = vi.fn(async () => {
      throw unrelatedError;
    });

    await expect(withWalletAdjustmentDisplayReference(adjustmentId, insert)).rejects.toBe(unrelatedError);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
