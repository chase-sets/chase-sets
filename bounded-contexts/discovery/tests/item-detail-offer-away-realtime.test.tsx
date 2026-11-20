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

const reloadScenarios = ["ordinary reload", "removal during reload", "removal during reload with changed Listing IDs"];

it.each(reloadScenarios)("reconciles the seller rail after %s", async (scenario) => {
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
  const resumedOffer = { ...baseOffer, price_amount: "42.00" };
  let quote = "quote_before_away";
  const routeData = () => ({
    entryAttemptKey: PAGE_VIEW_ENTRY_KEY,
    item:
      quote === "quote_before_away"
        ? item
        : createItem({
            offer_demand_matches: [resumedOffer],
            ...(scenario === "removal during reload with changed Listing IDs" ? { market_listings: [] } : {}),
          }),
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
  });
  const loader = vi.fn(async () => routeData());
  const router = createMemoryRouter([
    { path: "/", loader, Component: DiscoveryItemDetailRoute, HydrateFallback: () => null },
  ]);
  render(<RouterProvider router={router} />);
  await screen.findByRole("complementary", { name: "Commerce options" });
  const rail = () => within(screen.getByRole("complementary", { name: "Commerce options" }));
  const getQuote = () => {
    const button = rail().queryByRole("button", { name: "Accept offer" });
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
  expect(rail().queryByText("Can fulfill")).toBeNull();
  expect(getQuote()).toBeNull();
  expect(loader).toHaveBeenCalledTimes(1);

  quote = "quote_after_resume";
  const upsert = {
    entity: "discovery.buyerOffer",
    op: "upsert",
    id: baseOffer.offer_id,
    value: resumedOffer,
  } as const;
  if (scenario !== "ordinary reload") {
    const staleResponse = routeData();
    let finishReload!: (response: typeof staleResponse) => void;
    const reload = new Promise<typeof staleResponse>((resolve) => {
      finishReload = resolve;
    });
    loader.mockReturnValueOnce(reload);
    send(upsert);
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    send({ entity: "discovery.buyerOffer", op: "remove", id: baseOffer.offer_id });
    expect(getQuote()).toBeNull();
    await act(async () => finishReload(staleResponse));
    expect(router.state.revalidation).toBe("idle");
    expect(getQuote()).toBeNull();
    expect(screen.getByText("0 matching offers")).toBeTruthy();
    quote = "quote_after_second_resume";
  }
  send(upsert);
  await waitFor(() => expect(getQuote()).toBe(quote));
  expect(rail().getByText("Can fulfill")).toBeTruthy();
  expect(screen.getByText("1 matching offer")).toBeTruthy();
  expect(loader).toHaveBeenCalledTimes(scenario === "ordinary reload" ? 2 : 3);
});
