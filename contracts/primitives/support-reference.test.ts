import { describe, expect, it } from "vitest";
import { normalizeSupportReferenceInput, parseSupportReference } from "./support-reference";

describe("support reference routing primitive", () => {
  it("routes ORD-/SHP-/PYO-/SUP-/WAD- display references to their owning context", () => {
    expect(parseSupportReference("ORD-A1B2C3D4")).toEqual({
      kind: "display-reference",
      contextName: "ordering",
      reference: "ORD-A1B2C3D4",
    });
    expect(parseSupportReference("SHP-A1B2C3D4")).toEqual({
      kind: "display-reference",
      contextName: "fulfillment",
      reference: "SHP-A1B2C3D4",
    });
    expect(parseSupportReference("PYO-A1B2C3D4")).toEqual({
      kind: "display-reference",
      contextName: "settlement",
      reference: "PYO-A1B2C3D4",
    });
    expect(parseSupportReference("SUP-A1B2C3D4")).toEqual({
      kind: "display-reference",
      contextName: "platform-operations",
      reference: "SUP-A1B2C3D4",
    });
    expect(parseSupportReference("WAD-A1B2C3D4")).toEqual({
      kind: "display-reference",
      contextName: "settlement",
      reference: "WAD-A1B2C3D4",
    });
  });

  it("routes CSG- and CS-SL- references to checkout, disambiguating the shared CS prefix", () => {
    expect(parseSupportReference("CSG-CARDVAULT")).toEqual({
      kind: "display-reference",
      contextName: "checkout",
      reference: "CSG-CARDVAULT",
    });
    expect(parseSupportReference("CS-SL-A1B2C3D4")).toEqual({
      kind: "display-reference",
      contextName: "checkout",
      reference: "CS-SL-A1B2C3D4",
    });
  });

  it("normalizes forgivingly: trims, uppercases, and tolerates a missing hyphen", () => {
    expect(parseSupportReference("  ord-a1b2c3d4  ")).toEqual({
      kind: "display-reference",
      contextName: "ordering",
      reference: "ORD-A1B2C3D4",
    });
    expect(parseSupportReference("orda1b2c3d4")).toEqual({
      kind: "display-reference",
      contextName: "ordering",
      reference: "ORD-A1B2C3D4",
    });
    expect(parseSupportReference("csgcardvault")).toEqual({
      kind: "display-reference",
      contextName: "checkout",
      reference: "CSG-CARDVAULT",
    });
    expect(parseSupportReference("cssla1b2c3d4")).toEqual({
      kind: "display-reference",
      contextName: "checkout",
      reference: "CS-SL-A1B2C3D4",
    });
  });

  it("routes raw ord_/shp_/pyo_/sup_/wad_ typed ULIDs by parsing them via parseTypedId", () => {
    expect(parseSupportReference("ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9")).toEqual({
      kind: "typed-id",
      contextName: "ordering",
      typedIdPrefix: "ord",
      id: "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    });
    expect(parseSupportReference("shp_01jz6dkp7s7z4az5n5e6k7m8n9")).toEqual({
      kind: "typed-id",
      contextName: "fulfillment",
      typedIdPrefix: "shp",
      id: "shp_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    });
    expect(parseSupportReference("PYO_01JZ6DKP7S7Z4AZ5N5E6K7M8N9")).toEqual({
      kind: "typed-id",
      contextName: "settlement",
      typedIdPrefix: "pyo",
      id: "pyo_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    });
    expect(parseSupportReference("SUP_01JZ6DKP7S7Z4AZ5N5E6K7M8N9")).toEqual({
      kind: "typed-id",
      contextName: "platform-operations",
      typedIdPrefix: "sup",
      id: "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    });
    expect(parseSupportReference("wad_01jz6dkp7s7z4az5n5e6k7m8n9")).toEqual({
      kind: "typed-id",
      contextName: "settlement",
      typedIdPrefix: "wad",
      id: "wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    });
  });

  it("returns null for unrecognized input rather than throwing", () => {
    expect(parseSupportReference("")).toBeNull();
    expect(parseSupportReference("   ")).toBeNull();
    expect(parseSupportReference("not-a-reference")).toBeNull();
    expect(parseSupportReference("ORD-")).toBeNull();
    expect(parseSupportReference("acc_01JZ6DKP7S7Z4AZ5N5E6K7M8N9")).toBeNull();
  });

  it("normalizeSupportReferenceInput only trims, leaving casing to the caller", () => {
    expect(normalizeSupportReferenceInput("  ord-a1b2c3d4  ")).toBe("ord-a1b2c3d4");
  });
});
