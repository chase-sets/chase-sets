import { describe, expect, it } from "vitest";
import { confirmationIdFromSellListSupportReference, sellListConfirmationSupportReference } from "./support-reference";

describe("Sell List confirmation support references", () => {
  it("derives a customer-safe support reference from the confirmation id", () => {
    expect(sellListConfirmationSupportReference("slc_chk_sell_1")).toBe("CS-SL-CHK_SELL_1");
  });

  it("resolves a support reference back to the owned confirmation id", () => {
    expect(confirmationIdFromSellListSupportReference("CS-SL-CHK_SELL_1")).toBe("slc_chk_sell_1");
  });

  it("does not treat raw confirmation ids as support references", () => {
    expect(confirmationIdFromSellListSupportReference("slc_chk_sell_1")).toBeNull();
  });

  it("rejects malformed support reference suffixes", () => {
    expect(confirmationIdFromSellListSupportReference("CS-SL-CHK/SELL/1")).toBeNull();
  });
});
