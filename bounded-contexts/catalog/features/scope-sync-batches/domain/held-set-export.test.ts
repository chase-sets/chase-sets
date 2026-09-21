import { describe, expect, it } from "vitest";
import { HeldSetExportError, normalizeHeldSetLabel, parseHeldSetExport } from "./held-set-export";

const tcgplayerLiveExportHeaderFixture = [
  "TCGplayer Id",
  "Product Line",
  "Set Name",
  "Product Name",
  "Title",
  "Number",
  "Rarity",
  "Condition",
  "TCG Market Price",
  "TCG Direct Low",
  "TCG Low Price With Shipping",
  "TCG Low Price",
  "Total Quantity",
  "Add to Quantity",
  "TCG Marketplace Price",
  "Photo URL",
] as const;

describe("held-set export contract", () => {
  it("reads only the two pinned Live export columns and collapses normalized duplicate pairs", () => {
    const csv = [
      tcgplayerLiveExportHeaderFixture.join(","),
      row("1", "  Magic  ", "Time   Spiral", "secret product value"),
      row("2", "magic", "time spiral", "another ignored value"),
      row("3", "Yu-Gi-Oh!", '"Starter Deck: Yugi"', '"ignored, quoted\nvalue"'),
    ].join("\r\n");

    expect(parseHeldSetExport(new TextEncoder().encode(csv))).toEqual({
      totalRows: 3,
      pairs: [
        { productLine: "Magic", setName: "Time Spiral", rowCount: 2 },
        { productLine: "Yu-Gi-Oh!", setName: "Starter Deck: Yugi", rowCount: 1 },
      ],
    });
    expect(normalizeHeldSetLabel(" Yu-Gi-Oh! ")).toBe("yu-gi-oh!");
    expect(normalizeHeldSetLabel("Yu Gi Oh")).toBe("yu gi oh");
  });

  it("rejects missing, duplicate, and malformed required columns", () => {
    for (const csv of [
      "Product Line,Title\nMagic,ignored",
      "Product Line,Set Name,Set Name\nMagic,One,Two",
      'Product Line,Set Name\nMagic,"unterminated',
    ]) {
      expect(() => parseHeldSetExport(new TextEncoder().encode(csv))).toThrow(HeldSetExportError);
    }
  });

  it("refuses logical row 100001 before returning any pairs", () => {
    const csv = `Product Line,Set Name\n${"Magic,Time Spiral\n".repeat(100_001)}`;
    expect(() => parseHeldSetExport(new TextEncoder().encode(csv))).toThrowError(
      expect.objectContaining({ code: "row-limit-exceeded" }),
    );
  });
});

function row(id: string, productLine: string, setName: string, ignoredProductName: string): string {
  const values = tcgplayerLiveExportHeaderFixture.map((header) => {
    if (header === "TCGplayer Id") return id;
    if (header === "Product Line") return productLine;
    if (header === "Set Name") return setName;
    if (header === "Product Name") return ignoredProductName;
    return "";
  });
  return values.join(",");
}
