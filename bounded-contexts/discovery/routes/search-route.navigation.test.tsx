// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import SearchRoute, { SEARCH_DEBOUNCE_MS } from "./search";

// Regression for issue #4974 (same defect class as #4955): with the DS LinkAdapter
// registered by the marketplace shell (DiscoveryShellLayout), a search result card's
// "Add product to Buy Cart" action (an @chase-sets/design-system LinkButton) performs
// a client-side navigation instead of a full document load. The search page therefore
// stays alive while the item-detail loader runs, and a still-pending debounced search
// commit used to fire mid-navigation, interrupting the detail navigation and yanking
// the browser back to `/search?q=...`.
//
// Note: ListingCard's own full-card overlay link (`View details for ...`) renders a
// plain `<a>` outside the registered LinkAdapter, so it always does a full document
// load and is not exposed to this race. The per-item Buy/Sell/Watch actions render
// through LinkButton -> useLinkComponent() -> RouterLinkAdapter, so they are the real
// SPA navigation surface a shopper uses to leave the results grid within the debounce
// window.

vi.mock("@chase-sets/platform-runtime/realtime-web", () => ({
  createRealtimeRouteSubscriptionPreset: vi.fn((id: string, topics: readonly string[]) => ({ id, topics })),
  subscribeRealtimePatches: vi.fn(() => ({ close: vi.fn() })),
}));

const RESULT_ACTION_NAME = "Add product to Buy Cart";

function searchResultsFixture(search = "") {
  return {
    search,
    category: "",
    tag: "",
    language: "",
    marketActivity: "" as const,
    sort: "relevance",
    dynamicFilters: [],
    data: {
      items: [
        {
          catalog_item_id: "cat_pikachu",
          slug: "pikachu",
          language_code: "en",
          title: "Pikachu",
          subtitle: "Jungle 60/64 Common",
          description: "A catalog item for navigation regression tests.",
          blueprint_id: "bp_card",
          blueprint_name: "Pokemon Card Single",
          status: "active",
          category_names: ["Cards"],
          category_slugs: ["cards"],
          tags: ["pikachu"],
          image_urls: [],
          market_summary: {
            lowest_price_amount: "12.00",
            active_listing_count: 2,
            total_visible_quantity: 3,
          },
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      ],
      facets: [],
      total: 1,
      count: 1,
      nextCursor: null,
      retrievalMode: "lexical" as const,
      lexicalCount: 1,
    },
    categories: [],
    canonicalUrl: "http://localhost/search",
  };
}

function createDeferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<null>((resolveFn) => {
    resolve = () => resolveFn(null);
  });
  return { promise, resolve };
}

function renderMarketplaceSearchRouter(detailLoader: { promise: Promise<null> }) {
  const router = createMemoryRouter(
    [
      {
        path: "/search",
        loader: () => searchResultsFixture("pikachu"),
        Component: SearchRoute,
      },
      {
        path: "/items/:slug",
        loader: () => detailLoader.promise,
        Component: () => <h1>Item Detail</h1>,
      },
    ],
    { initialEntries: ["/search?q=pikachu"] },
  );

  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );

  return router;
}

describe("marketplace search detail navigation with a pending debounced search", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the result action as a real anchor through the registered LinkAdapter", async () => {
    const detailLoader = createDeferred();
    renderMarketplaceSearchRouter(detailLoader);

    const resultLink = await screen.findByRole("link", { name: RESULT_ACTION_NAME });
    expect(resultLink.tagName).toBe("A");
    expect(resultLink.getAttribute("href")).toBe("/items/pikachu?market=buy");
  });

  it("does not let the debounced search commit clobber an in-flight result navigation", async () => {
    const detailLoader = createDeferred();
    const router = renderMarketplaceSearchRouter(detailLoader);

    const resultLink = await screen.findByRole("link", { name: RESULT_ACTION_NAME });

    // Type into search (arms the debounce), then click the result action before the
    // debounce fires — the buyer search -> result-card sequence from the issue.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Charizard" } });
    fireEvent.click(resultLink);

    await waitFor(() => expect(router.state.navigation.state).toBe("loading"));

    // Let the debounce elapse while the detail loader is still in flight.
    await new Promise((resolveFn) => setTimeout(resolveFn, SEARCH_DEBOUNCE_MS * 3));
    detailLoader.resolve();

    await waitFor(() => expect(router.state.location.pathname).toBe("/items/pikachu"), { timeout: 2000 });
    await screen.findByRole("heading", { name: "Item Detail" });
  });

  it("flushes the pending search on focusout so a following result click always wins", async () => {
    const detailLoader = createDeferred();
    const router = renderMarketplaceSearchRouter(detailLoader);

    const resultLink = await screen.findByRole("link", { name: RESULT_ACTION_NAME });
    const search = screen.getByRole("searchbox");

    // Real browsers blur the search input on pointerdown BEFORE the link's click
    // handler runs its client-side navigation. The focusout must flush the pending
    // debounce immediately so the later click supersedes the search commit — the
    // reverse order is the #4955/#4974 clobber.
    fireEvent.change(search, { target: { value: "Charizard" } });
    fireEvent.focusOut(search, { relatedTarget: resultLink });
    fireEvent.click(resultLink);

    detailLoader.resolve();

    await waitFor(() => expect(router.state.location.pathname).toBe("/items/pikachu"), { timeout: 2000 });
    await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    await screen.findByRole("heading", { name: "Item Detail" });
  });

  it("commits immediately on focusout when the shopper stays on the results", async () => {
    const detailLoader = createDeferred();
    const router = renderMarketplaceSearchRouter(detailLoader);

    await screen.findByRole("link", { name: RESULT_ACTION_NAME });
    const search = screen.getByRole("searchbox");

    fireEvent.change(search, { target: { value: "Charizard" } });
    fireEvent.focusOut(search);

    await waitFor(() => expect(router.state.location.search).toBe("?q=Charizard"), { timeout: 2000 });
    expect(router.state.location.pathname).toBe("/search");
  });

  it("still commits the debounced search when the shopper stays on the results", async () => {
    const detailLoader = createDeferred();
    const router = renderMarketplaceSearchRouter(detailLoader);

    await screen.findByRole("link", { name: RESULT_ACTION_NAME });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Charizard" } });

    await waitFor(() => expect(router.state.location.search).toBe("?q=Charizard"), { timeout: 2000 });
    expect(router.state.location.pathname).toBe("/search");
  });
});
