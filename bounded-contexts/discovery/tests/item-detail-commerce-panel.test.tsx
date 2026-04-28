import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ItemCommercePanel,
  MarketplaceSellerRegistrationSection,
} from "../routes/item-detail";

describe("item detail commerce panel", () => {
  it("shows the sell tab when seller tools are represented by a registration CTA", () => {
    render(
      <ItemCommercePanel
        showSellerTab
        buyer={<div>Buy selected product</div>}
        seller={
          <MarketplaceSellerRegistrationSection
            productSummary="Raw / Near Mint"
            registerHref="/register?returnTo=%2Fitems%2Fcat_charizard"
          />
        }
      />,
    );

    expect(screen.getByRole("tab", { name: "Buy" })).toBeTruthy();
    const sellTab = screen.getByRole("tab", { name: "Sell" });
    expect(sellTab).toBeTruthy();

    fireEvent.click(sellTab);

    expect(screen.getByText("Sell on Chase Sets")).toBeTruthy();
    expect(screen.getByText("Start with: Raw / Near Mint")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Register to sell" }).getAttribute("href"))
      .toBe("/register?returnTo=%2Fitems%2Fcat_charizard");
  });
});
