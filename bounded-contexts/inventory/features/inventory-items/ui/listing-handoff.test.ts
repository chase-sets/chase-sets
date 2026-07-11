import { describe, expect, it } from "vitest";
import { appendInventoryHandoffSearch, inventoryListingHref } from "./listing-handoff";

describe("inventory listing handoff links", () => {
  it("carries fresh inventory handoff receipts into listing setup links", () => {
    expect(
      inventoryListingHref(
        "inv_1",
        "/account/inventory/items/inv_1?feedbackWorkflow=inventory-create&afterWrite=fresh&postWriteHandoff=handoff",
      ),
    ).toBe("/account/listings/new?inventoryItemId=inv_1&afterWrite=fresh&postWriteHandoff=handoff");
  });

  it("does not carry unrelated inventory page query parameters", () => {
    expect(inventoryListingHref("inv_1", "/account/inventory?feedbackWorkflow=inventory-create")).toBe(
      "/account/listings/new?inventoryItemId=inv_1",
    );
  });

  it("carries fresh inventory handoff receipts into inventory navigation links", () => {
    expect(
      appendInventoryHandoffSearch(
        "/account/inventory",
        "/account/inventory/imports/imb_1?afterWrite=fresh&postWriteHandoff=handoff",
      ),
    ).toBe("/account/inventory?afterWrite=fresh&postWriteHandoff=handoff");
  });
});
