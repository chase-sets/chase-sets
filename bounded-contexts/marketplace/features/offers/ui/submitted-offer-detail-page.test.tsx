// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplaceSubmittedOfferDetailPage } from "./submitted-offer-detail-page";
import type { SubmittedOfferDetail } from "./contracts";

afterEach(cleanup);

const offer: SubmittedOfferDetail = {
  offer_id: "off_1",
  buyer_account_id: "acc_buyer",
  catalog_catalog_item_id: "cat_one",
  product_id: "cat_one::",
  item_title: "Charizard",
  item_subtitle: null,
  selected_options: [],
  product_summary: null,
  price_amount: "20.00",
  price_currency_code: "USD",
  last_stream_version: 2,
  quantity_requested: 1,
  status: "submitted",
  accepted_seller_account_id: null,
  accepted_at: null,
  created_at: "2026-10-14T00:00:00.000Z",
  updated_at: "2026-10-14T00:00:00.000Z",
};

function renderDetail(
  status: string,
  outcomes: Parameters<typeof MarketplaceSubmittedOfferDetailPage>[0]["lifecycle"] = undefined,
) {
  const onAction = vi.fn();
  render(
    <MarketplaceSubmittedOfferDetailPage
      offer={{ ...offer, status }}
      lifecycle={outcomes ?? { pending: false, outcomes: null, onAction }}
    />,
  );
  return onAction;
}

describe("Submitted Offer detail lifecycle actions", () => {
  it("pauses an open Offer and confirms before withdrawing it", async () => {
    const onAction = renderDetail("submitted");
    expect(screen.queryByRole("button", { name: "Resume Offer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pause Offer" }));
    expect(onAction).toHaveBeenLastCalledWith("pause", ["off_1"]);
    onAction.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw Offer" }));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    expect(onAction).toHaveBeenCalledWith("withdraw", ["off_1"]);
  });

  it("resumes a paused Offer and explains that sellers cannot see it", () => {
    const onAction = renderDetail("paused");
    expect(screen.getByText("Sellers cannot see or accept this Offer until you resume it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause Offer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume Offer" }));
    expect(onAction).toHaveBeenCalledWith("resume", ["off_1"]);
    expect(screen.getByRole("button", { name: "Withdraw Offer" })).toBeTruthy();
  });

  it.each(["withdrawn", "accepted"])("offers no lifecycle actions on a %s Offer", (status) => {
    renderDetail(status);
    for (const name of ["Pause Offer", "Resume Offer", "Withdraw Offer"])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("shows the command result status before the projected detail catches up", () => {
    renderDetail("submitted", {
      pending: false,
      onAction: vi.fn(),
      outcomes: [{ offerId: "off_1", outcome: "changed", status: "paused", version: 3 }],
    });
    expect(screen.getByRole("button", { name: "Resume Offer" })).toBeTruthy();
    expect(screen.getByText("Charizard: now Paused")).toBeTruthy();
  });
});
