// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { t } from "@chase-sets/localization";
import type { BuyerOfferPolicySnapshot } from "../../../client";
import { terms } from "../../offer-policy/tests/fixtures";
import { MarketplaceSubmittedOfferDetailPage } from "./submitted-offer-detail-page";
import type { SubmittedOfferDetail } from "./contracts";

const fetcher = vi.hoisted(() => ({ state: "idle", data: undefined as unknown, submit: vi.fn() }));
vi.mock("react-router", async (original) => ({
  ...(await original<typeof import("react-router")>()),
  useFetcher: () => fetcher,
}));

afterEach(() => {
  cleanup();
  fetcher.data = undefined;
  fetcher.submit.mockClear();
});

const offer: SubmittedOfferDetail = {
  offer_id: "off_one",
  buyer_account_id: "acc_buyer",
  catalog_catalog_item_id: "cat_one",
  product_id: "cat_one::",
  item_title: "Item",
  item_subtitle: null,
  selected_options: [],
  product_summary: null,
  price_amount: "10.00",
  price_currency_code: "USD",
  last_stream_version: 2,
  quantity_requested: 2,
  status: "submitted",
  accepted_seller_account_id: null,
  accepted_at: null,
  created_at: "2026-10-13T00:00:00Z",
  updated_at: "2026-10-13T00:00:00Z",
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
    expect(onAction).toHaveBeenLastCalledWith("pause", ["off_one"]);
    onAction.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw Offer" }));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    expect(onAction).toHaveBeenCalledWith("withdraw", ["off_one"]);
  });

  it("resumes a paused Offer and explains that sellers cannot see it", () => {
    const onAction = renderDetail("paused");
    expect(screen.getByText("Sellers cannot see or accept this Offer until you resume it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause Offer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume Offer" }));
    expect(onAction).toHaveBeenCalledWith("resume", ["off_one"]);
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
      outcomes: [{ offerId: "off_one", outcome: "changed", status: "paused", version: 3 }],
    });
    expect(screen.getByRole("button", { name: "Resume Offer" })).toBeTruthy();
    expect(screen.getByText("Item: now Paused")).toBeTruthy();
  });
});

describe("submitted Offer market-following terms", () => {
  it.each(["active", "paused", "draft"] as const)(
    "shows only retained limits for a %s policy and exact consent copy",
    async (status) => {
      const policy: BuyerOfferPolicySnapshot = {
        policyId: "bop_one",
        status,
        version: 3,
        revision: 1,
        currency: "USD",
        offerVersions: { off_one: 2 },
        authority: status === "draft" ? null : terms,
        preview:
          status === "draft"
            ? {
                previewId: "a".repeat(64),
                policyVersion: 1,
                terms,
                outcomes: [
                  {
                    offerId: "off_one",
                    currentUnitItemAmount: "10.00",
                    result: { status: "target", unitItemAmount: "10.00", evidence: {} },
                  },
                ],
              }
            : null,
      };
      fetcher.data = { policy, error: null };
      const rendered = render(<MarketplaceSubmittedOfferDetailPage offer={offer} policies={[policy]} />);
      await act(async () => {});
      expect(rendered.container.textContent).not.toMatch(/allowance|consumed|remaining item/i);
      expect(screen.queryByLabelText(/allowance/i)).toBeNull();
      expect(rendered.container.textContent).toContain("Maximum unit item amount");
      expect(t("marketplace.marketFollowing.consent")).toBe(
        "I authorize these exact selected Offers, quantities, currency, adjustment and maximum unit item amounts. Resuming requires a fresh preview and consent.",
      );
      if (status === "draft")
        expect(screen.getByRole("checkbox", { name: t("marketplace.marketFollowing.consent") })).toBeTruthy();
      rendered.unmount();
    },
  );
});
