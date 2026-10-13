// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
