// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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

let restoreViewport: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restoreViewport?.();
  restoreViewport = undefined;
  vi.unstubAllGlobals();
});

function stubResponsiveViewport(initialWidth: number) {
  let width = initialWidth;
  const entries = new Set<{
    query: string;
    matches: boolean;
    listeners: Set<(event: MediaQueryListEvent) => void>;
    mediaQueryList: MediaQueryList;
  }>();
  const previousInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");

  const matchesQuery = (query: string) => {
    const minWidth = Number(query.match(/\(min-width:\s*(\d+)px\)/)?.[1] ?? 0);
    const maxWidth = Number(query.match(/\(max-width:\s*(\d+)px\)/)?.[1] ?? Number.POSITIVE_INFINITY);
    return width >= minWidth && width <= maxWidth;
  };

  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const entry = {
        query,
        matches: matchesQuery(query),
        listeners: new Set<(event: MediaQueryListEvent) => void>(),
        mediaQueryList: undefined as unknown as MediaQueryList,
      };
      entry.mediaQueryList = {
        get matches() {
          return entry.matches;
        },
        media: query,
        onchange: null,
        addEventListener(_type: string, listener: (event: MediaQueryListEvent) => void) {
          entry.listeners.add(listener);
        },
        removeEventListener(_type: string, listener: (event: MediaQueryListEvent) => void) {
          entry.listeners.delete(listener);
        },
        addListener(listener: (event: MediaQueryListEvent) => void) {
          entry.listeners.add(listener);
        },
        removeListener(listener: (event: MediaQueryListEvent) => void) {
          entry.listeners.delete(listener);
        },
        dispatchEvent: () => true,
      } as MediaQueryList;
      entries.add(entry);
      return entry.mediaQueryList;
    }),
  );
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });

  const setWidth = (nextWidth: number) => {
    width = nextWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    for (const entry of entries) {
      const nextMatches = matchesQuery(entry.query);
      if (nextMatches === entry.matches) continue;
      entry.matches = nextMatches;
      const event = { matches: nextMatches, media: entry.query } as MediaQueryListEvent;
      entry.listeners.forEach((listener) => listener(event));
    }
    window.dispatchEvent(new Event("resize"));
  };

  restoreViewport = () => {
    if (previousInnerWidth) Object.defineProperty(window, "innerWidth", previousInnerWidth);
    else Reflect.deleteProperty(window, "innerWidth");
  };

  return { setWidth };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

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
    expect(first).toHaveLength(4);
    const attemptsByAction = new Map<string, string[]>();
    for (const entry of first) {
      const ids = attemptsByAction.get(entry.action) ?? [];
      ids.push(String(entry.attemptId));
      attemptsByAction.set(entry.action, ids);
    }
    expect([...attemptsByAction.values()]).toEqual([
      [String(first[0]!.attemptId), String(first[0]!.attemptId)],
      [String(first[1]!.attemptId), String(first[1]!.attemptId)],
    ]);
    expect(new Set(attemptsByAction.keys()).size).toBe(2);
    expect(new Set([...attemptsByAction.values()].map(([attemptId]) => attemptId)).size).toBe(2);
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
  it("keeps one decline attempt per offer across the card and table layouts when a held decline is retried", async () => {
    const viewport = stubResponsiveViewport(640);
    const firstActionStarted = deferred();
    const secondActionStarted = deferred();
    const releaseFirstAction = deferred();
    const requests: { attemptId: string; signal: AbortSignal }[] = [];
    const secondOffer = { ...offer, offer_id: "off_2" };
    const router = createMemoryRouter([
      {
        path: "*",
        element: <OfferMatchListPage data={{ items: [offer, secondOffer] }} />,
        action: async ({ request }) => {
          const attemptId = String((await request.formData()).get("attemptId"));
          requests.push({ attemptId, signal: request.signal });
          if (requests.length === 1) {
            firstActionStarted.resolve();
            await releaseFirstAction.promise;
          } else {
            secondActionStarted.resolve();
          }
          return null;
        },
      },
    ]);
    const { container } = render(<RouterProvider router={router} />);
    const formFor = (layout: "card" | "table", offerId: string) => {
      const root = layout === "card" ? container.querySelector('[role="list"]') : container.querySelector("table");
      const form = root?.querySelector<HTMLFormElement>(`form[action$="/${offerId}"]`);
      expect(form, `${layout} form for ${offerId}`).not.toBeNull();
      if (!form) throw new Error(`Missing ${layout} form for ${offerId}`);
      return form;
    };
    const attemptIdIn = (form: HTMLFormElement) => String(new FormData(form).get("attemptId"));
    const cardOff1 = formFor("card", "off_1");
    const tableOff1 = formFor("table", "off_1");
    const cardOff2 = formFor("card", "off_2");
    const tableOff2 = formFor("table", "off_2");
    const cardButton = cardOff1.querySelector<HTMLButtonElement>('button[type="submit"]');
    const tableButton = tableOff1.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(cardButton).not.toBeNull();
    expect(tableButton).not.toBeNull();
    if (!cardButton || !tableButton) throw new Error("Decline forms must have submit buttons");

    fireEvent.click(cardButton);
    await act(async () => {
      await firstActionStarted.promise;
    });
    expect(requests).toHaveLength(1);

    await act(async () => {
      viewport.setWidth(1024);
      fireEvent.click(tableButton);
      await secondActionStarted.promise;
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests[0]!.attemptId).toBe(requests[1]!.attemptId);
    expect(requests[0]!.attemptId).toBe(attemptIdIn(cardOff1));
    expect(requests[1]!.attemptId).toBe(attemptIdIn(tableOff1));
    expect(attemptIdIn(cardOff2)).not.toBe(requests[0]!.attemptId);
    expect(attemptIdIn(tableOff2)).toBe(attemptIdIn(cardOff2));

    releaseFirstAction.resolve();
    await act(async () => {
      await releaseFirstAction.promise;
      await Promise.resolve();
    });
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
