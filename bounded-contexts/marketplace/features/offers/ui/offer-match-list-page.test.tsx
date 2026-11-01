// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { MarketplaceOfferMatchListPage as OfferMatchListPage } from "./offer-match-list-page";
import type { OfferMatchListItem } from "./contracts";

function MarketplaceOfferMatchListPage(props: Parameters<typeof OfferMatchListPage>[0]) {
  const router = createMemoryRouter([{ path: "*", element: <OfferMatchListPage {...props} /> }]);
  return <RouterProvider router={router} />;
}

const offer: OfferMatchListItem = {
  offer_id: "off_1",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Ash Ketchum",
  buyer_average_rating: "4.60",
  buyer_review_count: 7,
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::condition:raw",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [{ dimensionId: "condition", optionId: "raw" }],
  product_summary: "Raw / Near Mint",
  price_amount: "20.00",
  price_currency_code: "USD",
  last_stream_version: 2,
  quantity_requested: 1,
  status: "submitted",
  accepted_seller_account_id: null,
  accepted_at: null,
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
  listing_id: "lst_1",
  listing_price_amount: "22.00",
  listing_price_currency_code: "USD",
  listing_stream_version: 3,
  listing_quantity_cap: 2,
  listing_visible_quantity: 2,
  offer_price_gap_amount: "2.00",
  offer_to_listing_price_bps: 9091,
  seller_available_quantity: 2,
  seller_listing_availability_status: "available",
  can_fulfill: true,
};

afterEach(cleanup);

async function awaitDeclineSettle(
  router: ReturnType<typeof createMemoryRouter>,
  form: HTMLFormElement,
  sent: readonly string[],
  expectedSent: readonly string[],
) {
  await new Promise<void>((resolve) => {
    if (router.state.navigation.state === "idle") {
      resolve();
      return;
    }
    const unsubscribe = router.subscribe(({ navigation }) => {
      if (navigation.state === "idle") {
        unsubscribe();
        resolve();
      }
    });
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(router.state.navigation.state).toBe("idle");
  expect(form.dataset.formStatus).not.toBe("submitting");
  expect(form.hasAttribute("aria-busy")).toBe(false);
  expect(sent).toEqual(expectedSent);
}

describe("MarketplaceOfferMatchListPage", () => {
  it("has no Mute action or Muted buyers section and retains Add to Sell List", () => {
    const markup = renderToString(<MarketplaceOfferMatchListPage data={{ items: [offer] }} />);
    expect(markup).not.toMatch(/Mute buyer|Muted buyers|mute-offer-buyer|unmute-offer-buyer/i);
    expect(markup).toContain("Add selected offer to Sell List");
    expect(markup).toContain("decline-offer");
    expect(markup).toContain('name="attemptId"');
  });
  it("keeps a distinct decline attempt per row across re-renders and retries", async () => {
    function RefreshablePage() {
      const [items, setItems] = useState([offer, { ...offer, offer_id: "off_2" }]);
      return (
        <>
          <button onClick={() => setItems(items.map((item) => ({ ...item, buyer_display_name: "Updated buyer" })))}>
            Refresh
          </button>
          <OfferMatchListPage data={{ items }} />
        </>
      );
    }
    const sent: string[] = [];
    const router = createMemoryRouter([
      {
        path: "*",
        element: <RefreshablePage />,
        action: async ({ request }) => {
          sent.push(String((await request.formData()).get("attemptId")));
          return null;
        },
      },
    ]);
    const { container } = render(<RouterProvider router={router} />);
    const attempts = () =>
      [...container.querySelectorAll<HTMLFormElement>('form[action^="/account/offers/matches/"]')].map((form) => ({
        action: form.action,
        attemptId: new FormData(form).get("attemptId"),
      }));
    const first = attempts();
    expect(first.length).toBeGreaterThanOrEqual(2);
    for (const entry of first) expect(entry.attemptId).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(new Set(first.map((entry) => entry.attemptId)).size).toBe(first.length);
    expect(attempts()).toEqual(first);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(attempts()).toEqual(first);
    const decline = screen.getAllByRole("button", { name: "Decline" })[0]!;
    const declineForm = decline.closest("form");
    expect(declineForm).not.toBeNull();
    if (!declineForm) throw new Error("Decline control must be inside a form");
    const firstAttempt = String(first[0]!.attemptId);
    fireEvent.click(decline);
    expect(declineForm.getAttribute("aria-busy")).toBe("true");
    expect(declineForm.dataset.formStatus).toBe("submitting");
    await awaitDeclineSettle(router, declineForm, sent, [firstAttempt]);
    expect(sent).toEqual([firstAttempt]);
    expect(declineForm.getAttribute("aria-busy")).toBeNull();
    expect(declineForm.dataset.formStatus).not.toBe("submitting");
    fireEvent.click(decline);
    expect(declineForm.getAttribute("aria-busy")).toBe("true");
    expect(declineForm.dataset.formStatus).toBe("submitting");
    await awaitDeclineSettle(router, declineForm, sent, [firstAttempt, firstAttempt]);
    expect(sent).toEqual([firstAttempt, firstAttempt]);
    expect(declineForm.getAttribute("aria-busy")).toBeNull();
    expect(declineForm.dataset.formStatus).not.toBe("submitting");
    expect(attempts()).toEqual(first);
  });
  it("renders the sell-list explanation as tinted furniture", () => {
    render(<MarketplaceOfferMatchListPage data={{ items: [offer] }} />);

    const sellListSection = screen.getByRole("heading", { name: "Sell List" }).closest("section");
    const root = sellListSection?.querySelector(".rounded-tokenLg") ?? null;
    expect(root).not.toBeNull();
    const tokens = new Set((root as HTMLElement).className.split(/\s+/));
    expect(tokens.has("bg-surface-2")).toBe(true);
    for (const excluded of ["ds-glass", "border", "border-muted", "shadow-tokenSm", "shadow-tokenLg", "ds-glow"])
      expect(tokens.has(excluded), `sell-list explanation excludes ${excluded}`).toBe(false);
  });

  it("presents offer matches as a source list for checkout sell list review", () => {
    const markup = renderToString(<MarketplaceOfferMatchListPage data={{ items: [offer] }} />);

    expect(markup).toContain("Checkout Sell List");
    expect(markup).toContain("Offer Matches is now a Marketplace source list");
    expect(markup).toContain("Add selected offers to the Checkout Sell List");
    expect(markup).toContain('action="/account/sell-list"');
    expect(markup).toContain('name="intent" value="add-selected-offer"');
    expect(markup).toContain('name="offerId" value="off_1"');
    expect(markup).toContain('name="buyerDisplayName" value="Ash Ketchum"');
    expect(markup).toContain('name="offerPriceAmount" value="20.00"');
    expect(markup).toContain('name="catalogItemId" value="cat_charizard"');
    expect(markup).toContain('name="productId" value="cat_charizard::condition:raw"');
    expect(markup).toContain('name="selectedOptions"');
    expect(markup).not.toContain('name="buyerAccountId"');
    expect(markup).not.toContain("60601");
    expect(markup).not.toContain("seller_listing_availability");
    expect(markup).toContain("Add selected offer to Sell List");
  });

  it("shows listing price next to the best offer so sellers can judge the gap", () => {
    const markup = renderToString(<MarketplaceOfferMatchListPage data={{ items: [offer] }} />);

    expect(markup).toContain("Best Offer Matches");
    expect(markup).toContain("Your Listing");
    expect(markup).toContain("$22.00");
    expect(markup).toContain("$20.00");
    expect(markup).toContain("$2.00 below ask");
    expect(markup).toContain("Ash Ketchum");
    expect(markup).toContain("Buyer reputation");
  });

  it("shows buyer reputation on offer match rows", () => {
    const markup = renderToString(<MarketplaceOfferMatchListPage data={{ items: [offer] }} />);

    expect(markup).toContain("Buyer reputation");
    expect(markup).toContain("4.6");
    expect(markup).toContain("(<!-- -->7<!-- -->)");
  });
});
