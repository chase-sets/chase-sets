import { describe, expect, it } from "vitest";
import type { OrderId, PayoutId, ShipmentId, TypedUlid } from "./typed-ids";
import {
  DISPLAY_REFERENCE_PREFIX_BY_TYPED_ID_PREFIX,
  deriveDisplayReference,
  deriveDisplayReferenceOrRaw,
  displayReferencePrefixForTypedIdPrefix,
} from "./display-reference";

describe("display reference primitive", () => {
  it("derives deterministic references from typed ULIDs", () => {
    const orderId = "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9" as OrderId;

    expect(deriveDisplayReference(orderId)).toBe("ORD-E6K7M8N9");
    expect(deriveDisplayReference(orderId)).toBe("ORD-E6K7M8N9");
  });

  it("maps supported typed-id prefixes to display prefixes", () => {
    expect(DISPLAY_REFERENCE_PREFIX_BY_TYPED_ID_PREFIX).toEqual({
      ord: "ORD",
      shp: "SHP",
      pyo: "PYO",
    });
    expect(displayReferencePrefixForTypedIdPrefix("ord")).toBe("ORD");
    expect(displayReferencePrefixForTypedIdPrefix("shp")).toBe("SHP");
    expect(displayReferencePrefixForTypedIdPrefix("pyo")).toBe("PYO");
  });

  it("rejects unsupported typed-id prefixes", () => {
    expect(() => displayReferencePrefixForTypedIdPrefix("pay")).toThrow(
      "Unsupported display reference typed-id prefix 'pay'.",
    );
    expect(() => deriveDisplayReference("pay_01JZ6DKP7S7Z4AZ5N5E6K7M8N9" as TypedUlid<"pay">)).toThrow(
      "Unsupported display reference typed-id prefix 'pay'.",
    );
  });

  it("supports projection-time suffix lengthening", () => {
    const shipmentId = "shp_01JZ6DKP7S7Z4AZ5N5E6K7M8N9" as ShipmentId;

    expect(deriveDisplayReference(shipmentId)).toBe("SHP-E6K7M8N9");
    expect(deriveDisplayReference(shipmentId, { suffixLength: 10 })).toBe("SHP-N5E6K7M8N9");
    expect(deriveDisplayReference(shipmentId, { suffixLength: 12 })).toBe("SHP-Z5N5E6K7M8N9");
    expect(() => deriveDisplayReference(shipmentId, { suffixLength: 9 as never })).toThrow(
      "Display reference suffix length must be one of 8, 10, 12.",
    );
  });

  it("uppercases the ULID suffix", () => {
    const payoutId = "pyo_01jz6dkp7s7z4az5n5e6k7m8n9" as PayoutId;

    expect(deriveDisplayReference(payoutId)).toBe("PYO-E6K7M8N9");
  });
});

describe("deriveDisplayReferenceOrRaw", () => {
  it("derives the same reference as the strict variant for well-formed typed ULIDs", () => {
    const orderId = "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9" as OrderId;

    expect(deriveDisplayReferenceOrRaw(orderId)).toBe("ORD-E6K7M8N9");
  });

  it("falls back to the raw id verbatim for fixed, human-readable seed identifiers", () => {
    const seedOrderId = "ord_seed_checkout_pending" as OrderId;

    expect(deriveDisplayReferenceOrRaw(seedOrderId)).toBe(seedOrderId);
  });

  it("falls back to the raw id verbatim for unsupported typed-id prefixes", () => {
    const paymentId = "pay_01JZ6DKP7S7Z4AZ5N5E6K7M8N9" as TypedUlid<"pay">;

    expect(deriveDisplayReferenceOrRaw(paymentId)).toBe(paymentId);
  });
});
