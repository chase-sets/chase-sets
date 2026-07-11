import { describe, expect, it, vi } from "vitest";
import type { PayoutId } from "@chase-sets/primitives/typed-ids";
import { SETTLEMENT_PAYOUT_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT, withPayoutDisplayReference } from "./display-reference";

const payoutId = "pyo_01JZ6DKP7S7Z4AZ5N5E6K7M8N9" as PayoutId;

function uniqueViolation() {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint: SETTLEMENT_PAYOUT_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT,
  });
}

describe("withPayoutDisplayReference", () => {
  it("resolves the base 8-char reference when there is no collision", async () => {
    const insert = vi.fn(async (displayReference: string) => displayReference);

    const result = await withPayoutDisplayReference(payoutId, insert);

    expect(result).toBe("PYO-E6K7M8N9");
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("lengthens the suffix on a display-reference unique-index collision", async () => {
    const insert = vi
      .fn<(displayReference: string) => Promise<string>>()
      .mockRejectedValueOnce(uniqueViolation())
      .mockImplementationOnce(async (displayReference) => displayReference);

    const result = await withPayoutDisplayReference(payoutId, insert);

    expect(result).toBe("PYO-N5E6K7M8N9");
    expect(insert).toHaveBeenNthCalledWith(1, "PYO-E6K7M8N9");
    expect(insert).toHaveBeenNthCalledWith(2, "PYO-N5E6K7M8N9");
  });

  it("retries through 12 chars before giving up", async () => {
    const insert = vi.fn(async () => {
      throw uniqueViolation();
    });

    await expect(withPayoutDisplayReference(payoutId, insert)).rejects.toMatchObject({
      code: "23505",
      constraint: SETTLEMENT_PAYOUT_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT,
    });
    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert).toHaveBeenNthCalledWith(3, "PYO-Z5N5E6K7M8N9");
  });

  it("propagates non-collision errors immediately without retrying", async () => {
    const unrelatedError = new Error("connection reset");
    const insert = vi.fn(async () => {
      throw unrelatedError;
    });

    await expect(withPayoutDisplayReference(payoutId, insert)).rejects.toBe(unrelatedError);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("falls back to the raw id verbatim for fixed, human-readable seed payout ids", async () => {
    const seedPayoutId = "pyo_seed_completed" as PayoutId;
    const insert = vi.fn(async (displayReference: string) => displayReference);

    const result = await withPayoutDisplayReference(seedPayoutId, insert);

    expect(result).toBe(seedPayoutId);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("does not retry the fallback on a collision since the value never changes", async () => {
    const seedPayoutId = "pyo_seed_completed" as PayoutId;
    const insert = vi.fn(async () => {
      throw uniqueViolation();
    });

    await expect(withPayoutDisplayReference(seedPayoutId, insert)).rejects.toMatchObject({
      code: "23505",
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
