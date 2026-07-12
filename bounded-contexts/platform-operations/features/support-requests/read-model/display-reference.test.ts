import { describe, expect, it, vi } from "vitest";
import type { SupportRequestId } from "@chase-sets/primitives/typed-ids";
import {
  SUPPORT_REQUEST_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT,
  withSupportRequestDisplayReference,
} from "./display-reference";

const supportRequestId = "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9" as SupportRequestId;

function uniqueViolation() {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint: SUPPORT_REQUEST_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT,
  });
}

describe("withSupportRequestDisplayReference", () => {
  it("uses the stable eight-character SUP reference", async () => {
    const insert = vi.fn(async (displayReference: string) => displayReference);

    await expect(withSupportRequestDisplayReference(supportRequestId, insert)).resolves.toBe("SUP-E6K7M8N9");
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("lengthens the suffix after the support-reference unique constraint collides", async () => {
    const insert = vi
      .fn<(displayReference: string) => Promise<string>>()
      .mockRejectedValueOnce(uniqueViolation())
      .mockImplementationOnce(async (displayReference) => displayReference);

    await expect(withSupportRequestDisplayReference(supportRequestId, insert)).resolves.toBe("SUP-N5E6K7M8N9");
    expect(insert).toHaveBeenNthCalledWith(1, "SUP-E6K7M8N9");
    expect(insert).toHaveBeenNthCalledWith(2, "SUP-N5E6K7M8N9");
  });

  it("does not retry unrelated failures", async () => {
    const failure = new Error("connection reset");
    const insert = vi.fn(async () => {
      throw failure;
    });

    await expect(withSupportRequestDisplayReference(supportRequestId, insert)).rejects.toBe(failure);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy seed identifiers readable without retrying an unchanged fallback", async () => {
    const seedId = "sup_seed_active_product_not_received" as SupportRequestId;
    const insert = vi.fn(async (displayReference: string) => displayReference);

    await expect(withSupportRequestDisplayReference(seedId, insert)).resolves.toBe(seedId);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
