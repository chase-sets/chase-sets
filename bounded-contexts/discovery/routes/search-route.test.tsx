// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeProjectionPatch, RealtimeSyncRequired } from "@chase-sets/platform-runtime/realtime";
import type { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import type { DiscoveryBulkCartPreview, DiscoverySearchResponse } from "../support/request-support/api-client";
import { buildSearchResultSetKey, persistSearchRestoration } from "../features/search/ui/search-scroll-restoration";

const {
  mockUseLoaderData,
  mockUseLocation,
  mockUseNavigate,
  mockUseNavigation,
  mockUseRevalidator,
  mockUseSearchParams,
  mockSubscribeRealtimePatches,
} = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseLocation: vi.fn(),
  mockUseNavigate: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockUseRevalidator: vi.fn(),
  mockUseSearchParams: vi.fn(),
  mockSubscribeRealtimePatches: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useLocation: mockUseLocation,
    useNavigate: mockUseNavigate,
    useNavigation: mockUseNavigation,
    useRevalidator: mockUseRevalidator,
    useSearchParams: mockUseSearchParams,
  };
});

vi.mock("@chase-sets/platform-runtime/realtime-web", () => ({
  createRealtimeRouteSubscriptionPreset: vi.fn((id, topics) => ({ id, topics })),
  subscribeRealtimePatches: mockSubscribeRealtimePatches,
}));

import SearchRoute, { clientLoader, loader } from "./search";
import {
  cacheSearchLoaderData,
  readCachedSearchLoaderData,
  searchLoaderCacheKey,
} from "../features/search/ui/search-loader-cache";

type SubscribeRealtimePatchesOptions = Parameters<typeof subscribeRealtimePatches>[0];

function searchData(search = "", language = "") {
  return {
    search,
    category: "",
    language,
    tag: "",
    marketActivity: "" as const,
    priceMin: "",
    priceMax: "",
    inStock: false,
    sort: "relevance",
    page: 1,
    data: {
      items: [],
      category_counts: [{ slug: "cards", count: 2 }],
      total: 0,
      count: 0,
      nextCursor: null,
      retrievalMode: "lexical" as const,
      lexicalCount: 0,
    },
    categories: [
      {
        category_id: "ctg_cards",
        key: "cards",
        slug: "cards",
        name: "Cards",
        item_count: 2,
      },
    ],
    canonicalUrl: "http://localhost/search",
  };
}

function searchDataWithResults(search = "", language = "") {
  const data = searchData(search, language);

  return {
    ...data,
    data: {
      items: [
        {
          catalog_item_id: "cat_pikachu",
          slug: "pikachu",
          language_code: "en",
          title: "Pikachu",
          subtitle: "Jungle 60/64 Common",
          description: "A catalog item for route behavior tests.",
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
      category_counts: [{ slug: "cards", count: 2 }],
      total: 1,
      count: 1,
      nextCursor: null,
    },
  };
}

function searchDataWithCursor(search = "") {
  const data = searchDataWithResults(search);

  return {
    ...data,
    data: {
      ...data.data,
      total: null,
      nextCursor: "cursor_2",
    },
  };
}

function searchDataWithMarketOnlyResult(search = "") {
  const data = searchDataWithResults(search);

  return {
    ...data,
    data: {
      ...data.data,
      items: data.data.items.map((item) => ({
        ...item,
        market_summary: {
          lowest_price_amount: null,
          active_listing_count: 0,
          total_visible_quantity: 0,
        },
      })),
    },
  };
}

describe("marketplace search route", () => {
  beforeEach(() => {
    mockUseLocation.mockReturnValue({ pathname: "/search", search: "", hash: "", state: null, key: "test" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn(), state: "idle" });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("falls back to an empty search state when loader data is unavailable", () => {
    mockUseLoaderData.mockReturnValue(undefined);
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);

    const html = renderToString(<SearchRoute />);

    expect(html).toContain("Search Pikachu, Spider-Man, Jordan, vintage packs...");
  });

  it("debounces search URL updates and commits the latest value", () => {
    vi.useFakeTimers();
    const setSearchParams = vi.fn();
    mockUseLoaderData.mockReturnValue(searchData());
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("page=2"), setSearchParams]);

    render(<SearchRoute />);

    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "c" } });
    fireEvent.change(input, { target: { value: "ch" } });
    fireEvent.change(input, { target: { value: "charizard" } });

    act(() => vi.advanceTimersByTime(299));
    expect(setSearchParams).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));

    expect(setSearchParams).toHaveBeenCalledTimes(1);
    const [updater, options] = setSearchParams.mock.calls[0];
    const next = updater(new URLSearchParams("page=2"));
    expect(next.get("q")).toBe("charizard");
    expect(next.has("search")).toBe(false);
    expect(next.has("page")).toBe(false);
    expect(options).toMatchObject({ preventScrollReset: true, replace: true });
  });

  it("flushes the pending search immediately when Enter submits", () => {
    vi.useFakeTimers();
    const setSearchParams = vi.fn();
    mockUseLoaderData.mockReturnValue(searchData());
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("page=2"), setSearchParams]);

    render(<SearchRoute />);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "charizard" } });
    fireEvent.submit(screen.getByRole("search"));

    expect(setSearchParams).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(300));
    expect(setSearchParams).toHaveBeenCalledTimes(1);
    const [updater, options] = setSearchParams.mock.calls[0];
    const next = updater(new URLSearchParams("page=2"));
    expect(next.get("q")).toBe("charizard");
    expect(next.has("page")).toBe(false);
    expect(options).toMatchObject({ preventScrollReset: true, replace: true });
  });

  it("keeps the user's draft when stale loader data renders before debounce completes", () => {
    vi.useFakeTimers();
    let loaderData = searchData("char");
    mockUseLoaderData.mockImplementation(() => loaderData);
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("search=char"), vi.fn()]);

    const { rerender } = render(<SearchRoute />);
    const input = screen.getByRole("searchbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "charizard" } });
    loaderData = searchData("char");
    rerender(<SearchRoute />);

    expect(input.value).toBe("charizard");
  });

  it("keeps search focused when the hero changes to the results toolbar", () => {
    vi.useFakeTimers();
    const setSearchParams = vi.fn();
    let loaderData = searchData();
    mockUseLoaderData.mockImplementation(() => loaderData);
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), setSearchParams]);

    const { rerender } = render(<SearchRoute />);
    const heroInput = screen.getByRole("searchbox") as HTMLInputElement;
    heroInput.focus();
    fireEvent.change(heroInput, { target: { value: "c" } });

    act(() => vi.advanceTimersByTime(300));
    loaderData = searchData("c");
    rerender(<SearchRoute />);

    const toolbarInput = screen.getByRole("searchbox") as HTMLInputElement;
    expect(toolbarInput.value).toBe("c");
    expect(document.activeElement).toBe(toolbarInput);
  });

  it("clearing search removes search and page params", () => {
    vi.useFakeTimers();
    const setSearchParams = vi.fn();
    mockUseLoaderData.mockReturnValue(searchData("pikachu"));
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu&page=3"), setSearchParams]);

    render(<SearchRoute />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    act(() => vi.advanceTimersByTime(300));

    const [updater] = setSearchParams.mock.calls[0];
    const next = updater(new URLSearchParams("q=pikachu&page=3"));
    expect(next.has("q")).toBe(false);
    expect(next.has("search")).toBe(false);
    expect(next.has("page")).toBe(false);
  });

  it("clears only search immediately from zero-result recovery", () => {
    const setSearchParams = vi.fn();
    mockUseLoaderData.mockReturnValue(searchData("pikachu", "ja"));
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu&language=ja&page=3"), setSearchParams]);

    render(<SearchRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(setSearchParams).toHaveBeenCalledTimes(1);
    const [updater, options] = setSearchParams.mock.calls[0];
    const next = updater(new URLSearchParams("q=pikachu&language=ja&page=3"));
    expect(next.has("q")).toBe(false);
    expect(next.get("language")).toBe("ja");
    expect(next.has("page")).toBe(false);
    expect(options).toMatchObject({ preventScrollReset: true, replace: true });
  });

  it("navigates category changes without forcing a document reload", () => {
    const navigate = vi.fn();
    mockUseLoaderData.mockReturnValue(searchDataWithResults("pikachu"));
    mockUseNavigate.mockReturnValue(navigate);
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu&page=3"), vi.fn()]);

    render(<SearchRoute />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cards (2)" })[0]);

    expect(navigate).toHaveBeenCalledWith("/categories/cards?q=pikachu", {
      preventScrollReset: true,
    });
  });

  it("removes applied language filters and clears pagination", () => {
    const setSearchParams = vi.fn();
    mockUseLoaderData.mockReturnValue(searchDataWithResults("pikachu", "ja"));
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu&language=ja&page=3"), setSearchParams]);

    render(<SearchRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Language: Japanese" }));

    const [updater, options] = setSearchParams.mock.calls[0];
    const next = updater(new URLSearchParams("q=pikachu&language=ja&page=3"));
    expect(next.get("q")).toBe("pikachu");
    expect(next.has("language")).toBe(false);
    expect(next.has("page")).toBe(false);
    expect(options).toMatchObject({ preventScrollReset: true, replace: false });
  });

  it("applies top-level language filter changes without forcing a document reload", () => {
    const setSearchParams = vi.fn();
    mockUseLoaderData.mockReturnValue(searchDataWithResults("pikachu"));
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu&page=3"), setSearchParams]);

    render(<SearchRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Japanese" }));

    const [updater, options] = setSearchParams.mock.calls[0];
    const next = updater(new URLSearchParams("q=pikachu&page=3"));
    expect(next.get("q")).toBe("pikachu");
    expect(next.get("language")).toBe("ja");
    expect(next.has("page")).toBe(false);
    expect(options).toMatchObject({ preventScrollReset: true, replace: false });
  });

  it("round-trips price and in-stock loader state to the Discovery API", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (new URL(url).pathname.endsWith("/categories")) {
          return Response.json({ items: [], total: 0, count: 0 });
        }
        return Response.json({
          items: [],
          facets: [],
          total: 0,
          count: 0,
          nextCursor: null,
          retrievalMode: "lexical",
          lexicalCount: 0,
        });
      }),
    );

    const result = await loader({
      request: new Request("http://localhost/search?priceMin=10.00&priceMax=25.00&inStock=true&sort=price_desc"),
      params: {},
      context: {},
    } as unknown as Parameters<typeof loader>[0]);

    expect(result).toMatchObject({ priceMin: "10.00", priceMax: "25.00", inStock: true, sort: "price_desc" });
    const apiRequest = requests.find((request) => new URL(request).pathname.endsWith("/items"));
    expect(apiRequest).toBeDefined();
    const apiParams = new URL(apiRequest ?? "http://localhost").searchParams;
    expect(apiParams.get("priceMin")).toBe("10.00");
    expect(apiParams.get("priceMax")).toBe("25.00");
    expect(apiParams.get("inStock")).toBe("true");
    expect(apiParams.get("sort")).toBe("price_desc");
    expect(apiParams.get("includeTotal")).toBe("true");
  });

  it("loads the home result set and newest arrivals in parallel", async () => {
    const itemRequests: string[] = [];
    let releaseFirstItemRequest: ((response: Response) => void) | undefined;
    const firstItemResponse = new Promise<Response>((resolve) => {
      releaseFirstItemRequest = resolve;
    });
    const emptyResponse = {
      items: [],
      facets: [],
      total: 0,
      count: 0,
      nextCursor: null,
      retrievalMode: "lexical",
      lexicalCount: 0,
    } as const;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (new URL(url).pathname.endsWith("/categories")) {
          return Response.json({ items: [], total: 0, count: 0 });
        }
        if (new URL(url).pathname.endsWith("/items")) {
          itemRequests.push(url);
          return itemRequests.length === 1 ? firstItemResponse : Response.json(emptyResponse);
        }
        return Response.json({ items: [], count: 0 });
      }),
    );

    const loaderResult = loader({
      request: new Request("http://localhost/"),
      params: {},
      context: {},
    } as unknown as Parameters<typeof loader>[0]);

    await waitFor(() => expect(itemRequests).toHaveLength(2));
    releaseFirstItemRequest?.(Response.json(emptyResponse));
    const result = await loaderResult;

    expect(itemRequests.map((request) => new URL(request).searchParams.get("sort"))).toEqual(["relevance", "newest"]);
    expect(result).toMatchObject({
      homeMerchandising: { featuredCategories: [], newArrivals: [] },
    });
  });

  it("removes applied price and in-stock URL state without retaining pagination", () => {
    const setSearchParams = vi.fn();
    mockUseLoaderData.mockReturnValue({
      ...searchDataWithResults("pikachu"),
      priceMin: "10.00",
      priceMax: "25.00",
      inStock: true,
      sort: "price_asc",
    });
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    const current = new URLSearchParams("q=pikachu&priceMin=10.00&priceMax=25.00&inStock=true&sort=price_asc&page=3");
    mockUseSearchParams.mockReturnValue([current, setSearchParams]);

    render(<SearchRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Minimum price: $10.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Maximum price: $25.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove In stock" }));

    const minimumParams = setSearchParams.mock.calls[0][0](current);
    const maximumParams = setSearchParams.mock.calls[1][0](current);
    const inStockParams = setSearchParams.mock.calls[2][0](current);
    expect(minimumParams.has("priceMin")).toBe(false);
    expect(maximumParams.has("priceMax")).toBe(false);
    expect(inStockParams.has("inStock")).toBe(false);
    expect(minimumParams.has("page")).toBe(false);
    expect(maximumParams.has("page")).toBe(false);
    expect(inStockParams.has("page")).toBe(false);
  });

  it("makes product result cards direct item-detail links without compare copy", () => {
    mockUseLoaderData.mockReturnValue(searchDataWithResults("pikachu"));
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu"), vi.fn()]);

    render(<SearchRoute />);

    expect(
      screen.getByRole("link", { name: "View details for Pikachu — Jungle 60/64 Common" }).getAttribute("href"),
    ).toBe("/items/pikachu");
    expect(screen.getByRole("link", { name: "Add product to Buy Cart" }).getAttribute("href")).toBe(
      "/items/pikachu?market=buy",
    );
    expect(screen.getByRole("link", { name: "Add product to Sell List" }).getAttribute("href")).toBe(
      "/items/pikachu?market=sell",
    );
    expect(screen.getByRole("link", { name: "Watch product" }).getAttribute("href")).toBe(
      "/items/pikachu?market=watch",
    );
    expect(screen.getAllByText("English").length).toBeGreaterThan(0);
    expect(screen.queryByText("Language: en")).toBeNull();
    expect(screen.queryByText("Compare")).toBeNull();
    expect(screen.queryByText("Compare price, seller trust, and fulfillment before choosing.")).toBeNull();
  });

  it("keeps market-only result cards focused on product identity and actions", () => {
    mockUseLoaderData.mockReturnValue(searchDataWithMarketOnlyResult("pikachu"));
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu"), vi.fn()]);

    render(<SearchRoute />);

    expect(screen.queryByText("Market open")).toBeNull();
    expect(screen.queryByText("Supply wanted")).toBeNull();
    expect(screen.queryByText("No active listings")).toBeNull();
    expect(screen.queryByText("Offer or list yours")).toBeNull();
    expect(screen.getByText("Jungle 60/64 Common")).toBeTruthy();
    expect(screen.queryByText("Make an offer or list yours to help this market form.")).toBeNull();
    expect(screen.getByRole("link", { name: "Add product to Buy Cart" }).getAttribute("href")).toBe(
      "/items/pikachu?market=buy",
    );
    expect(screen.getByRole("link", { name: "Add product to Sell List" }).getAttribute("href")).toBe(
      "/items/pikachu?market=sell",
    );
    expect(screen.queryByText("Watch market")).toBeNull();
  });

  it("loads more product results by cursor without changing the search URL", async () => {
    const setSearchParams = vi.fn();
    const secondPageItem = {
      ...searchDataWithResults("raichu").data.items[0],
      catalog_item_id: "cat_raichu",
      slug: "raichu",
      title: "Raichu",
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            items: [secondPageItem],
            facets: [],
            total: null,
            count: 1,
            nextCursor: null,
            retrievalMode: "lexical",
            lexicalCount: 1,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    mockUseLoaderData.mockReturnValue(searchDataWithCursor("pikachu"));
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu"), setSearchParams]);

    render(<SearchRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Load more results" }));

    await waitFor(() => expect(screen.getByText("Raichu")).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(requestedUrl).toContain("/api/marketplace/items?");
    expect(requestedUrl).toContain("search=pikachu");
    expect(requestedUrl).toContain("limit=24");
    expect(requestedUrl).toContain("cursor=cursor_2");
    expect(requestedUrl).not.toContain("includeTotal=true");
    expect(requestedUrl).not.toContain("offset=");
    expect(setSearchParams).not.toHaveBeenCalled();
  });

  it("rehydrates cursor-loaded results before a matching search route remounts", async () => {
    const secondPage = persistedSearchPage("cat_raichu", "raichu", "Raichu");
    const loaderData = searchDataWithCursor("pikachu");
    persistSearchRestoration(window.sessionStorage, resultSetKey(loaderData), [secondPage], 640);
    mockUseLoaderData.mockReturnValue(loaderData);
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu"), vi.fn()]);

    const firstVisit = render(<SearchRoute />);
    expect(screen.getByText("Raichu")).toBeTruthy();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 640, left: 0, behavior: "instant" });
    firstVisit.unmount();

    render(<SearchRoute />);
    expect(screen.getByText("Raichu")).toBeTruthy();
  });

  it("does not rehydrate cursor pages after the Discovery Query changes", () => {
    const secondPage = persistedSearchPage("cat_raichu", "raichu", "Raichu");
    const pikachuData = searchDataWithCursor("pikachu");
    persistSearchRestoration(window.sessionStorage, resultSetKey(pikachuData), [secondPage], 640);
    let loaderData: ReturnType<typeof searchDataWithCursor> | ReturnType<typeof searchDataWithResults> = pikachuData;
    mockUseLoaderData.mockImplementation(() => loaderData);
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu"), vi.fn()]);

    const { rerender } = render(<SearchRoute />);
    expect(screen.getByText("Raichu")).toBeTruthy();

    loaderData = searchDataWithResults("mewtwo");
    rerender(<SearchRoute />);

    expect(screen.queryByText("Raichu")).toBeNull();
  });

  it("treats a final cursor page as terminal after merging loaded results", async () => {
    const secondPageItem = {
      ...searchDataWithResults("raichu").data.items[0],
      catalog_item_id: "cat_raichu",
      slug: "raichu",
      title: "Raichu",
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            items: [secondPageItem],
            facets: [],
            total: null,
            count: 1,
            nextCursor: null,
            retrievalMode: "lexical",
            lexicalCount: 1,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    mockUseLoaderData.mockReturnValue(searchDataWithCursor("pikachu"));
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu"), vi.fn()]);

    render(<SearchRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Load more results" }));

    await waitFor(() => expect(screen.getByText("Raichu")).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Load more results" })).toBeNull();
  });

  it("applies realtime market patches to cursor-loaded product results", async () => {
    const secondPageItem = {
      ...searchDataWithResults("raichu").data.items[0],
      catalog_item_id: "cat_raichu",
      slug: "raichu",
      title: "Raichu",
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            items: [secondPageItem],
            facets: [],
            total: null,
            count: 1,
            nextCursor: null,
            retrievalMode: "lexical",
            lexicalCount: 1,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    mockUseLoaderData.mockReturnValue(searchDataWithCursor("pikachu"));
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu"), vi.fn()]);

    const loadedVisit = render(<SearchRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Load more results" }));

    await waitFor(() => expect(screen.getByText("Raichu")).toBeTruthy());

    loadedVisit.unmount();
    render(<SearchRoute />);
    expect(screen.getByText("Raichu")).toBeTruthy();

    const subscriptionOptions = (
      mockSubscribeRealtimePatches.mock.calls.at(-1) as [SubscribeRealtimePatchesOptions] | undefined
    )?.[0];
    const patch = {
      kind: "projection.patch",
      context: "discovery",
      projection: "discovery-market-projection",
      topics: ["public:market"],
      changes: [
        {
          op: "summary",
          entity: "discovery.marketSummary",
          id: "cat_raichu",
          value: {
            lowest_price_amount: "7.00",
            active_listing_count: 4,
            total_visible_quantity: 4,
          },
        },
      ],
    } satisfies RealtimeProjectionPatch;

    act(() => subscriptionOptions?.onPatch(patch));

    await waitFor(() => expect(screen.getByText("From $7.00")).toBeTruthy());
  });

  it("revalidates the current route when the realtime stream requires a full sync", () => {
    const revalidate = vi.fn();
    mockUseRevalidator.mockReturnValue({ revalidate, state: "idle" });
    mockUseLoaderData.mockReturnValue(searchDataWithResults("pikachu"));
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu"), vi.fn()]);

    render(<SearchRoute />);

    const subscriptionOptions = (
      mockSubscribeRealtimePatches.mock.calls.at(-1) as [SubscribeRealtimePatchesOptions] | undefined
    )?.[0];
    act(() => {
      subscriptionOptions?.onSyncRequired({
        kind: "sync.required",
        reason: "cursor-expired",
        contexts: ["discovery"],
      } satisfies RealtimeSyncRequired);
    });

    expect(revalidate).toHaveBeenCalledOnce();
  });

  it("suppresses stale bulk add snapshots after the result set changes", async () => {
    let resolvePreview: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          resolvePreview = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let loaderData = searchDataWithResults("pikachu");
    mockUseLoaderData.mockImplementation(() => loaderData);
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu"), vi.fn()]);

    const { rerender } = render(<SearchRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Add matching products to Buy Cart" }));

    loaderData = searchDataWithResults("raichu");
    rerender(<SearchRoute />);

    await act(async () => {
      resolvePreview(
        new Response(
          JSON.stringify({
            status: "bulk-preview",
            preview: bulkPreview(),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Add eligible products")).toBeNull();
  });

  it("renders a visible bulk add failure when the POST fails", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "Route action missing." }), { status: 405 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    mockUseLoaderData.mockReturnValue(searchDataWithResults("pikachu"));
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu"), vi.fn()]);

    render(<SearchRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Add matching products to Buy Cart" }));

    await waitFor(() => expect(screen.getByText("Could not add matching products")).toBeTruthy());
    expect(
      screen.getByText(
        "We could not add matching products to Buy Cart. Try again, or open a product to add it individually.",
      ),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("marketplace search back-navigation restoration", () => {
  beforeEach(() => {
    mockUseLocation.mockReturnValue({ pathname: "/search", search: "?q=pikachu", hash: "", state: null, key: "test" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn(), state: "idle" });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("serves a cached Result Set on back navigation without a server refetch", async () => {
    const cached = searchDataWithResults("pikachu");
    cacheSearchLoaderData(window.sessionStorage, searchLoaderCacheKey("/search?q=pikachu"), cached);
    const serverLoader = vi.fn(async () => {
      throw new Error("clientLoader must not refetch when a fresh Result Set is cached.");
    });

    const result = await clientLoader({
      request: new Request("http://localhost/search?q=pikachu"),
      params: {},
      context: {},
      serverLoader,
    } as unknown as Parameters<typeof clientLoader>[0]);

    expect(serverLoader).not.toHaveBeenCalled();
    expect(result).toEqual(cached);
  });

  it("falls back to the authoritative server loader when nothing is cached", async () => {
    const fresh = searchDataWithResults("pikachu");
    const serverLoader = vi.fn(async () => fresh);

    const result = await clientLoader({
      request: new Request("http://localhost/search?q=pikachu"),
      params: {},
      context: {},
      serverLoader,
    } as unknown as Parameters<typeof clientLoader>[0]);

    expect(serverLoader).toHaveBeenCalledTimes(1);
    expect(result).toEqual(fresh);
  });

  it("warms the loader cache while a Result Set is on screen so a later return is instant", async () => {
    const loaderData = searchDataWithResults("pikachu");
    mockUseLoaderData.mockReturnValue(loaderData);
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu"), vi.fn()]);

    render(<SearchRoute />);

    await waitFor(() =>
      expect(readCachedSearchLoaderData(window.sessionStorage, searchLoaderCacheKey("/search?q=pikachu"))).toEqual(
        loaderData,
      ),
    );
  });
});

function bulkPreview(): DiscoveryBulkCartPreview {
  return {
    totalMatches: 1,
    eligibleCount: 1,
    skippedCount: 0,
    overLimit: false,
    limit: 24,
    lines: [
      {
        catalog_item_id: "cat_pikachu",
        slug: "pikachu",
        product_id: "cat_pikachu::form:raw",
        title: "Pikachu",
        subtitle: "Jungle 60/64 Common",
        image_url: null,
        image_srcset: null,
        image_loading_url: null,
        image_loading_alt: null,
        image_loading_srcset: null,
        selected_options: [],
        product_summary: "Raw",
        quantity: 1,
      },
    ],
    skippedItems: [],
  };
}

function resultSetKey(data: {
  search: string;
  category: string;
  tag: string;
  language: string;
  marketActivity: string;
  priceMin: string;
  priceMax: string;
  inStock: boolean;
  sort: string;
}) {
  return buildSearchResultSetKey({
    search: data.search,
    category: data.category,
    tag: data.tag,
    language: data.language,
    marketActivity: data.marketActivity,
    priceMin: data.priceMin,
    priceMax: data.priceMax,
    inStock: data.inStock,
    sort: data.sort,
    dynamicFilters: [],
  });
}

function persistedSearchPage(catalogItemId: string, slug: string, title: string): DiscoverySearchResponse {
  const item = searchDataWithResults(title).data.items[0];
  if (!item) {
    throw new Error("Expected a search result fixture.");
  }

  return {
    items: [
      {
        ...item,
        catalog_item_id: catalogItemId,
        slug,
        title_i18n: null,
        title,
        subtitle_i18n: null,
        display_badges: [],
        description_i18n: null,
        product_asset_sets: [],
        image_fallback: null,
      },
    ],
    facets: [],
    category_counts: [{ slug: "cards", count: 1 }],
    total: null,
    count: 1,
    nextCursor: null,
    retrievalMode: "lexical",
    lexicalCount: 1,
  };
}
