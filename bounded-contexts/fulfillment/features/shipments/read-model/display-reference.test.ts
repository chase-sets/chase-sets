import { describe, expect, it, vi } from "vitest";
import type { ShipmentId } from "@chase-sets/primitives/typed-ids";
import {
  FULFILLMENT_SHIPMENT_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT,
  withShipmentDisplayReference,
} from "./display-reference";

const shipmentId = "shp_01JZ6DKP7S7Z4AZ5N5E6K7M8N9" as ShipmentId;

function uniqueViolation() {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint: FULFILLMENT_SHIPMENT_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT,
  });
}

describe("withShipmentDisplayReference", () => {
  it("resolves the base 8-char reference when there is no collision", async () => {
    const insert = vi.fn(async (displayReference: string) => displayReference);

    const result = await withShipmentDisplayReference(shipmentId, insert);

    expect(result).toBe("SHP-E6K7M8N9");
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("lengthens the suffix on a display-reference unique-index collision", async () => {
    const insert = vi
      .fn<(displayReference: string) => Promise<string>>()
      .mockRejectedValueOnce(uniqueViolation())
      .mockImplementationOnce(async (displayReference) => displayReference);

    const result = await withShipmentDisplayReference(shipmentId, insert);

    expect(result).toBe("SHP-N5E6K7M8N9");
    expect(insert).toHaveBeenNthCalledWith(1, "SHP-E6K7M8N9");
    expect(insert).toHaveBeenNthCalledWith(2, "SHP-N5E6K7M8N9");
  });

  it("retries through 12 chars before giving up", async () => {
    const insert = vi.fn(async () => {
      throw uniqueViolation();
    });

    await expect(withShipmentDisplayReference(shipmentId, insert)).rejects.toMatchObject({
      code: "23505",
      constraint: FULFILLMENT_SHIPMENT_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT,
    });
    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert).toHaveBeenNthCalledWith(3, "SHP-Z5N5E6K7M8N9");
  });

  it("propagates non-collision errors immediately without retrying", async () => {
    const unrelatedError = new Error("connection reset");
    const insert = vi.fn(async () => {
      throw unrelatedError;
    });

    await expect(withShipmentDisplayReference(shipmentId, insert)).rejects.toBe(unrelatedError);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("falls back to the raw id verbatim for fixed, human-readable seed shipment ids", async () => {
    const seedShipmentId = "shp_seed_demo_charizard" as ShipmentId;
    const insert = vi.fn(async (displayReference: string) => displayReference);

    const result = await withShipmentDisplayReference(seedShipmentId, insert);

    expect(result).toBe(seedShipmentId);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("does not retry the fallback on a collision since the value never changes", async () => {
    const seedShipmentId = "shp_seed_demo_charizard" as ShipmentId;
    const insert = vi.fn(async () => {
      throw uniqueViolation();
    });

    await expect(withShipmentDisplayReference(seedShipmentId, insert)).rejects.toMatchObject({
      code: "23505",
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
