// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { OfferMatchListItem } from "./contracts";
import { OfferMatchDeclineAttemptProvider } from "./offer-match-decline-attempt-provider";
import { MarketplaceOfferMatchListPage } from "./offer-match-list-page";

const ATTEMPT_ID = /^[A-Za-z0-9_-]{22,128}$/;

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
const secondOffer: OfferMatchListItem = { ...offer, offer_id: "off_2" };

type Actor = Readonly<{ sessionId: string; accountId: string }>;
const seller: Actor = { sessionId: "ses_seller", accountId: "acc_seller" };

afterEach(cleanup);

let mounts = 0;

// Each call mounts a fresh list page (a new router and key), so only the provider can carry an id across calls.
function listUnder(actor: Actor | null, items: readonly OfferMatchListItem[]) {
  const router = createMemoryRouter([{ path: "*", element: <MarketplaceOfferMatchListPage data={{ items }} /> }]);
  mounts += 1;
  return (
    <OfferMatchDeclineAttemptProvider sessionId={actor?.sessionId ?? null} accountId={actor?.accountId ?? null}>
      <RouterProvider key={mounts} router={router} />
    </OfferMatchDeclineAttemptProvider>
  );
}

function declineForms(root: ParentNode, offerId: string) {
  return (['[role="list"]', "table"] as const).map((layout) => {
    const form = root.querySelector(layout)?.querySelector<HTMLFormElement>(`form[action$="/${offerId}"]`);
    expect(form, `${layout} decline form for ${offerId}`).toBeTruthy();
    return form!;
  });
}

function heldAttemptId(root: ParentNode, offerId: string) {
  const [card, table] = declineForms(root, offerId).map((form) => String(new FormData(form).get("attemptId")));
  expect(card).toMatch(ATTEMPT_ID);
  expect(table, `card and table hold one id for ${offerId}`).toBe(card);
  return card!;
}

function serverMarkup(markup: string) {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return host;
}

describe("OfferMatchDeclineAttemptProvider", () => {
  it("holds one id per offer across layouts and page remounts", () => {
    const view = render(listUnder(seller, [offer, secondOffer]));
    const first = heldAttemptId(view.container, "off_1");
    const second = heldAttemptId(view.container, "off_2");
    expect(second).not.toBe(first);

    view.rerender(listUnder(seller, [offer, secondOffer]));
    expect(heldAttemptId(view.container, "off_1")).toBe(first);
    expect(heldAttemptId(view.container, "off_2")).toBe(second);
  });

  it("releases only the entry of an offer rendered non-submitted", () => {
    const view = render(listUnder(seller, [offer, secondOffer]));
    const first = heldAttemptId(view.container, "off_1");
    const second = heldAttemptId(view.container, "off_2");

    view.rerender(listUnder(seller, [{ ...offer, status: "declined" }, secondOffer]));
    for (const form of declineForms(view.container, "off_1")) {
      expect(String(new FormData(form).get("attemptId"))).toMatch(ATTEMPT_ID);
      expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    }
    expect(heldAttemptId(view.container, "off_2")).toBe(second);

    view.rerender(listUnder(seller, [offer, secondOffer]));
    const reopened = heldAttemptId(view.container, "off_1");
    expect(reopened).not.toBe(first);
    expect(heldAttemptId(view.container, "off_2")).toBe(second);
  });

  it("gives each account switch, including a switch back, a new id within the session", () => {
    const view = render(listUnder(seller, [offer]));
    const sellerAttempt = heldAttemptId(view.container, "off_1");

    view.rerender(listUnder({ ...seller }, [offer]));
    expect(heldAttemptId(view.container, "off_1"), "an unchanged session and account keep their id").toBe(
      sellerAttempt,
    );

    view.rerender(listUnder({ ...seller, accountId: "acc_other" }, [offer]));
    const otherAttempt = heldAttemptId(view.container, "off_1");
    expect(otherAttempt).not.toBe(sellerAttempt);

    view.rerender(listUnder(seller, [offer]));
    const switchedBackAttempt = heldAttemptId(view.container, "off_1");
    expect(switchedBackAttempt, "switching back clears the earlier account's id").not.toBe(sellerAttempt);
    expect(switchedBackAttempt).not.toBe(otherAttempt);
  });

  it("gives a new same-account session a new id", () => {
    const view = render(listUnder(seller, [offer]));
    const sellerAttempt = heldAttemptId(view.container, "off_1");

    view.rerender(listUnder({ ...seller, sessionId: "ses_next" }, [offer]));
    expect(heldAttemptId(view.container, "off_1")).not.toBe(sellerAttempt);
  });

  it("drops every held id when the actor signs out", () => {
    const view = render(listUnder(seller, [offer]));
    const sellerAttempt = heldAttemptId(view.container, "off_1");

    view.rerender(listUnder(null, [offer]));
    const signedOutAttempt = heldAttemptId(view.container, "off_1");
    expect(signedOutAttempt).not.toBe(sellerAttempt);

    view.rerender(listUnder(seller, [offer]));
    expect(heldAttemptId(view.container, "off_1")).not.toBe(sellerAttempt);
  });

  it("gives two independent server renders of one session, account and offer their own ids", () => {
    const firstRender = serverMarkup(renderToString(listUnder(seller, [offer])));
    const secondRender = serverMarkup(renderToString(listUnder(seller, [offer])));

    expect(heldAttemptId(secondRender, "off_1")).not.toBe(heldAttemptId(firstRender, "off_1"));
  });
});
