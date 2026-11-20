// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { RealtimeProjectionPatchChange } from "@chase-sets/platform-runtime/realtime";
import DiscoveryItemDetailRoute from "../routes/item-detail";
import {
  baseAccountOfferMatch,
  baseOffer,
  createItem,
  PAGE_VIEW_ENTRY_KEY,
} from "./item-detail-commerce-panel-test-harness";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("removes the Match from an open seller rail and reloads its terms when the Offer returns", async () => {
  const sources: EventTarget[] = [];
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      constructor() {
        super();
        sources.push(this);
      }

      close() {}
    },
  );

  const item = createItem();
  let quote = "quote_before_away";
  const loader = vi.fn(async () => ({
    entryAttemptKey: PAGE_VIEW_ENTRY_KEY,
    item,
    accountOfferMatches: [
      {
        ...baseAccountOfferMatch,
        acceptance_terms: {
          account_type: "personal",
          basis_amount: baseOffer.price_amount,
          marketplace_sales_fee_unit_amount: "0.00",
          seller_net_unit_amount: baseOffer.price_amount,
          shipping_allowance_percentage_bps: 500,
          schedule_id: null,
          agreement_id: null,
          resolved_at: baseOffer.updated_at,
          fee_quote_fingerprint: quote,
        },
      },
    ],
    sellerInventoryItems: [],
    sellerAccountId: "seller_1",
    hasListingStockLocation: true,
    listingSetupLoadState: "ready",
    viewerAccountId: "seller_1",
    initialMarketIntent: "sell",
    initialSelectedOfferId: baseOffer.offer_id,
    initialSelectedOptions: [],
    hasInitialSelectedOptionFilters: false,
    showSellerTab: true,
    canUseSellerFeatures: true,
    canUseListingFeatures: true,
    canSubmitOffers: true,
    registerToSellHref: "/register",
    notFound: false,
    error: null,
    canonicalUrl: null,
  }));
  const router = createMemoryRouter([{ path: "/", loader, Component: DiscoveryItemDetailRoute }]);
  render(<RouterProvider router={router} />);
  const rail = await screen.findByRole("complementary", { name: "Commerce options" });
  const getQuote = () => {
    const button = within(rail).queryByRole("button", { name: "Accept offer" });
    const form = button?.closest("form");
    return form ? new FormData(form).get("feeQuoteFingerprint") : null;
  };
  expect(getQuote()).toBe("quote_before_away");
  await waitFor(() => expect(sources).toHaveLength(1));

  const send = (change: RealtimeProjectionPatchChange) =>
    act(() => {
      sources[0]!.dispatchEvent(
        new MessageEvent("projection.patch", {
          data: JSON.stringify({
            kind: "projection.patch",
            context: "discovery",
            projection: "discovery-market-projection",
            topics: [`item:${item.catalog_item_id}`],
            changes: [change],
          }),
        }),
      );
    });
  send({ entity: "discovery.buyerOffer", op: "remove", id: baseOffer.offer_id });
  expect(within(rail).queryByText("Can fulfill")).toBeNull();
  expect(getQuote() || null).toBeNull();
  expect(loader).toHaveBeenCalledTimes(1);

  quote = "quote_after_resume";
  send({ entity: "discovery.buyerOffer", op: "upsert", id: baseOffer.offer_id, value: baseOffer });
  await waitFor(() => expect(getQuote()).toBe("quote_after_resume"));
  expect(within(rail).getByText("Can fulfill")).toBeTruthy();
  expect(loader).toHaveBeenCalledTimes(2);
});
