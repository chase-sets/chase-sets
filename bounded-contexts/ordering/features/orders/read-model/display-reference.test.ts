import { describe, expect, it, vi } from "vitest";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import { ORDERING_ORDER_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT, withOrderDisplayReference } from "./display-reference";

const orderId = "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9" as OrderId;

function uniqueViolation() {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint: ORDERING_ORDER_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT,
  });
}

describe("withOrderDisplayReference", () => {
  it("resolves the base 8-char reference when there is no collision", async () => {
    const insert = vi.fn(async (displayReference: string) => displayReference);

    const result = await withOrderDisplayReference(orderId, insert);

    expect(result).toBe("ORD-E6K7M8N9");
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("lengthens the suffix on a display-reference unique-index collision", async () => {
    const insert = vi
      .fn<(displayReference: string) => Promise<string>>()
      .mockRejectedValueOnce(uniqueViolation())
      .mockImplementationOnce(async (displayReference) => displayReference);

    const result = await withOrderDisplayReference(orderId, insert);

    expect(result).toBe("ORD-N5E6K7M8N9");
    expect(insert).toHaveBeenNthCalledWith(1, "ORD-E6K7M8N9");
    expect(insert).toHaveBeenNthCalledWith(2, "ORD-N5E6K7M8N9");
  });

  it("retries through 12 chars before giving up", async () => {
    const insert = vi.fn(async () => {
      throw uniqueViolation();
    });

    await expect(withOrderDisplayReference(orderId, insert)).rejects.toMatchObject({
      code: "23505",
      constraint: ORDERING_ORDER_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT,
    });
    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert).toHaveBeenNthCalledWith(3, "ORD-Z5N5E6K7M8N9");
  });

  it("propagates non-collision errors immediately without retrying", async () => {
    const unrelatedError = new Error("connection reset");
    const insert = vi.fn(async () => {
      throw unrelatedError;
    });

    await expect(withOrderDisplayReference(orderId, insert)).rejects.toBe(unrelatedError);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("falls back to the raw id verbatim for fixed, human-readable seed order ids", async () => {
    const seedOrderId = "ord_seed_checkout_pending" as OrderId;
    const insert = vi.fn(async (displayReference: string) => displayReference);

    const result = await withOrderDisplayReference(seedOrderId, insert);

    expect(result).toBe(seedOrderId);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("does not retry the fallback on a collision since the value never changes", async () => {
    const seedOrderId = "ord_seed_checkout_pending" as OrderId;
    const insert = vi.fn(async () => {
      throw uniqueViolation();
    });

    await expect(withOrderDisplayReference(seedOrderId, insert)).rejects.toMatchObject({
      code: "23505",
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
