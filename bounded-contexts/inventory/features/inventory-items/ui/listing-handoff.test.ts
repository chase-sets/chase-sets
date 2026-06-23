import { describe, expect, it } from "vitest";
import { inventoryListingHref } from "./listing-handoff";

describe("inventory listing handoff links", () => {
  it("carries fresh inventory handoff receipts into listing setup links", () => {
    expect(
      inventoryListingHref(
        "inv_1",
        "/account/inventory/items/inv_1?feedbackWorkflow=inventory-create&afterWrite=fresh&postWriteHandoff=handoff",
      ),
    ).toBe("/account/listings?inventoryItemId=inv_1&afterWrite=fresh&postWriteHandoff=handoff");
  });

  it("does not carry unrelated inventory page query parameters", () => {
    expect(inventoryListingHref("inv_1", "/account/inventory?feedbackWorkflow=inventory-create")).toBe(
      "/account/listings?inventoryItemId=inv_1",
    );
  });
});
