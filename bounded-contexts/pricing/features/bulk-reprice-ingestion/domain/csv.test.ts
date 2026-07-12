import { describe, expect, it } from "vitest";
import {
  buildBulkRepriceCsvTemplate,
  buildBulkRepriceResultsCsv,
  parseBulkRepriceCsv,
  parseBulkRepriceJsonRows,
} from "./csv";

describe("parseBulkRepriceCsv", () => {
  it("parses valid rows with either sellerSku or listingId", () => {
    const csv = ["sellerSku,listingId,newPrice", "ABC-123,,12.99", ",lst_1,9.50"].join("\n");
    const rows = parseBulkRepriceCsv(csv);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      rowNumber: 2,
      sellerSku: "ABC-123",
      listingId: null,
      newPriceAmount: "12.99",
      validationErrors: [],
    });
    expect(rows[1]).toEqual({
      rowNumber: 3,
      sellerSku: null,
      listingId: "lst_1",
      newPriceAmount: "9.50",
      validationErrors: [],
    });
  });

  it("skips blank rows", () => {
    const csv = ["sellerSku,listingId,newPrice", "ABC-123,,12.99", ",,", ""].join("\n");
    const rows = parseBulkRepriceCsv(csv);
    expect(rows).toHaveLength(1);
  });

  it("flags rows missing both sellerSku and listingId", () => {
    const csv = ["sellerSku,listingId,newPrice", ",,12.99"].join("\n");
    const rows = parseBulkRepriceCsv(csv);
    expect(rows[0]!.validationErrors).toContain("Row must include a sellerSku or a listingId.");
  });

  it("flags a missing price", () => {
    const csv = ["sellerSku,listingId,newPrice", "ABC-123,,"].join("\n");
    const rows = parseBulkRepriceCsv(csv);
    expect(rows[0]!.validationErrors).toContain("Row is missing a new price.");
  });

  it("flags a non-money price", () => {
    const csv = ["sellerSku,listingId,newPrice", "ABC-123,,not-a-price"].join("\n");
    const rows = parseBulkRepriceCsv(csv);
    expect(rows[0]!.validationErrors[0]).toMatch(/not a valid positive money amount/);
  });

  it("flags a zero or negative price", () => {
    const csv = ["sellerSku,listingId,newPrice", "ABC-123,,0.00", "ABC-124,,-1.00"].join("\n");
    const rows = parseBulkRepriceCsv(csv);
    expect(rows[0]!.validationErrors).toHaveLength(1);
    expect(rows[1]!.validationErrors).toHaveLength(1);
  });

  it("handles quoted fields with embedded commas", () => {
    const csv = ["sellerSku,listingId,newPrice", '"ABC, 123",,12.99'].join("\n");
    const rows = parseBulkRepriceCsv(csv);
    expect(rows[0]!.sellerSku).toBe("ABC, 123");
  });

  it("returns an empty array for an empty file", () => {
    expect(parseBulkRepriceCsv("")).toEqual([]);
  });
});

describe("parseBulkRepriceJsonRows", () => {
  it("parses and validates rows from JSON input", () => {
    const rows = parseBulkRepriceJsonRows([
      { sellerSku: "ABC-123", newPriceAmount: "12.99" },
      { listingId: "lst_1", newPriceAmount: 9.5 },
      {},
    ]);

    expect(rows).toHaveLength(3);
    expect(rows[0]!.validationErrors).toEqual([]);
    expect(rows[1]!.newPriceAmount).toBe("9.5");
    expect(rows[2]!.validationErrors.length).toBeGreaterThan(0);
  });
});

describe("buildBulkRepriceCsvTemplate", () => {
  it("includes the header row", () => {
    const template = buildBulkRepriceCsvTemplate();
    expect(template.split("\n")[0]).toBe("sellerSku,listingId,newPrice");
  });
});

describe("buildBulkRepriceResultsCsv", () => {
  it("renders one row per outcome", () => {
    const csv = buildBulkRepriceResultsCsv([
      {
        row_number: 1,
        seller_sku: "ABC-123",
        listing_id: null,
        requested_price_amount: "12.99",
        resolved_listing_id: "lst_1",
        previous_price_amount: "11.00",
        outcome: "applied",
        error_message: null,
      },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "rowNumber,sellerSku,listingId,requestedPrice,resolvedListingId,previousPrice,outcome,errorMessage",
    );
    expect(lines[1]).toBe("1,ABC-123,,12.99,lst_1,11.00,applied,");
  });
});
