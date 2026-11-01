// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { useEffect, useState } from "react";
import { RouterProvider, createMemoryRouter, createStaticHandler, type RouteObject } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeProjectionPatch, RealtimeSyncRequired } from "@chase-sets/platform-runtime/realtime";
import type { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import type { DiscoverySearchResponse } from "../support/request-support/api-client";
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
    useFetcher: () => ({ state: "idle", data: undefined, reset: mockResetBulkFetcher, submit: vi.fn() }),
  };
});

const mockResetBulkFetcher = vi.fn();

vi.mock("@chase-sets/platform-runtime/realtime-web", () => ({
  createRealtimeRouteSubscriptionPreset: vi.fn((id, topics) => ({ id, topics })),
  subscribeRealtimePatches: mockSubscribeRealtimePatches,
}));

import SearchRoute, { clientLoader, loader, PRICE_FILTER_DEBOUNCE_MS } from "./search";
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
            lowest_price_currency_code: "USD",
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
          lowest_price_currency_code: null,
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

  it.each(["/search?q=charizard", "/"])("primary search failure is not empty success: %s", async (path) => {
    const secret = "synthetic-upstream-secret-10610";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/categories")) {
        return Response.json({
          items: [{ ...searchData().categories[0], display_order: 1 }],
          total: 1,
          count: 1,
        });
      }
      if (url.searchParams.get("sort") === "newest") return Response.json(searchDataWithResults().data);
      return Response.json({ message: secret }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createStaticHandler([{ id: "search", path: "*", loader }]).query(
      new Request(`http://localhost${path}`),
    );
    if (result instanceof Response) throw new Error("Expected retained search route data");
    expect(result.statusCode).toBe(502);
    expect(result.errors).toBeNull();
    expect(JSON.stringify(result.loaderData)).not.toContain(secret);
    mockUseLoaderData.mockReturnValue(result.loaderData.search);
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(path.split("?")[1]), vi.fn()]);
    mockUseLocation.mockReturnValue({ pathname: path.split("?")[0], search: path.includes("?") ? "?q=charizard" : "" });
    render(<SearchRoute />);
    expect(screen.getByRole("searchbox")).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Minimum price" })).toBeTruthy();
    expect(screen.getByText("Search results could not load. Try again in a moment.")).toBeTruthy();
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.queryByText("No items found")).toBeNull();
    expect(document.body.textContent).not.toContain(secret);
    expect(readCachedSearchLoaderData(window.sessionStorage, searchLoaderCacheKey(path))).toBeNull();
    if (path === "/") {
      expect(screen.getByRole("link", { name: /Pikachu/ })).toBeTruthy();
      expect(screen.getAllByText("Cards").length).toBeGreaterThan(0);
    }
  });

  it("search success empty and secondary-failure matrix", async () => {
    const responses = new Map<string, unknown>([
      ["empty", { items: [], facets: [], total: 0, count: 0, nextCursor: null }],
      ["populated", searchDataWithResults().data],
    ]);
    let mode = "empty";
    let secondaryFailure: "newest" | "categories" | null = "newest";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/categories")) {
          return secondaryFailure === "categories"
            ? Response.json({ message: "categories unavailable" }, { status: 500 })
            : Response.json({ items: [{ ...searchData().categories[0], display_order: 1 }], total: 1, count: 1 });
        }
        if (secondaryFailure === "newest" && url.searchParams.get("sort") === "newest")
          return Response.json({ message: "new arrivals unavailable" }, { status: 500 });
        return Response.json(responses.get(mode));
      }),
    );
    const load = () =>
      loader({ request: new Request("http://localhost/search?q=charizard"), params: {}, context: {} } as never);
    const empty = await load();
    expect(empty).toMatchObject({ searchFailed: false, data: { total: 0, items: [] } });
    mode = "populated";
    const populated = await load();
    expect(populated).toMatchObject({ searchFailed: false, data: { total: 1, items: [{ slug: "pikachu" }] } });
    expect(populated).toMatchObject({ homeMerchandising: null });

    secondaryFailure = "newest";
    const newArrivalsFailed = await loader({
      request: new Request("http://localhost/"),
      params: {},
      context: {},
    } as never);
    expect(newArrivalsFailed).toMatchObject({
      searchFailed: false,
      data: { total: 1, items: [{ slug: "pikachu" }] },
      homeMerchandising: { newArrivals: [] },
    });
    expect("type" in (newArrivalsFailed as object)).toBe(false);

    secondaryFailure = "categories";
    const categoriesFailed = await loader({
      request: new Request("http://localhost/"),
      params: {},
      context: {},
    } as never);
    expect(categoriesFailed).toMatchObject({
      searchFailed: false,
      data: { total: 1, items: [{ slug: "pikachu" }] },
      categories: [],
    });
    expect("type" in (categoriesFailed as object)).toBe(false);
  });

  it("search failure to successful navigation", async () => {
    let failed = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/categories")) return Response.json({ items: [], total: 0, count: 0 });
      if (failed) return Response.json({ secret: "synthetic-secret" }, { status: 500 });
      return Response.json(searchDataWithResults().data);
    });
    vi.stubGlobal("fetch", fetchMock);
    let routeData: unknown;
    let router: ReturnType<typeof createMemoryRouter>;
    function RoutedSearch() {
      const [, setVersion] = useState(0);
      useEffect(() => {
        const update = (state: typeof router.state) => {
          routeData = state.loaderData.search;
          setVersion((version) => version + 1);
        };
        update(router.state);
        return router.subscribe(update);
      }, []);
      return <SearchRoute />;
    }
    const searchRoute: RouteObject = {
      id: "search",
      path: "/search",
      loader: (args) =>
        clientLoader({
          ...args,
          serverLoader: () => loader(args),
        } as Parameters<typeof clientLoader>[0]),
      Component: RoutedSearch,
    };
    router = createMemoryRouter([searchRoute], { initialEntries: ["/search?q=charizard"] });
    routeData = router.state.loaderData.search;
    mockUseLoaderData.mockImplementation(() => router.state.loaderData.search);
    mockUseLocation.mockImplementation(() => router.state.location);
    mockUseNavigate.mockImplementation(() => router.navigate);
    mockUseNavigation.mockImplementation(() => router.state.navigation);
    mockUseRevalidator.mockImplementation(() => ({ revalidate: router.revalidate, state: router.state.revalidation }));
    mockUseSearchParams.mockImplementation(() => [new URLSearchParams(router.state.location.search), vi.fn()]);
    try {
      render(<RouterProvider router={router} />);

      await waitFor(
        () => expect(screen.getByText("Search results could not load. Try again in a moment.")).toBeTruthy(),
        { timeout: 5000 },
      );
      expect(screen.queryByText("No items found")).toBeNull();
      expect(readCachedSearchLoaderData(window.sessionStorage, searchLoaderCacheKey("/search?q=charizard"))).toBeNull();
      const storedCache = JSON.parse(window.sessionStorage.getItem("discovery.search.loader-cache.v1") ?? "null") as {
        entries?: unknown[];
      } | null;
      expect(storedCache?.entries).toEqual([]);

      const failedFetches = fetchMock.mock.calls.length;
      failed = false;
      await act(async () => {
        await router.navigate("/search?q=charizard", { replace: true });
      });
      await waitFor(() =>
        expect(screen.queryByText("Search results could not load. Try again in a moment.")).toBeNull(),
      );
      expect(routeData).toMatchObject({ searchFailed: false, data: { items: [{ slug: "pikachu" }] } });
      expect(fetchMock.mock.calls.length).toBeGreaterThan(failedFetches);
      expect(screen.getByRole("link", { name: /Pikachu/ })).toBeTruthy();
      expect(
        readCachedSearchLoaderData(window.sessionStorage, searchLoaderCacheKey("/search?q=charizard")),
      ).toMatchObject({
        searchFailed: false,
        data: { items: [{ slug: "pikachu" }] },
      });
    } finally {
      router.dispose();
    }
  });

  it("falls back to an empty search state when loader data is unavailable", () => {
    mockUseLoaderData.mockReturnValue(undefined);
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);

    const html = renderToString(<SearchRoute />);

    expect(html).toContain("Search Charizard, Black Lotus, Dark Magician, Luffy...");
  });

  it("debounces search URL updates and commits the latest value", async () => {
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

    await act(() => vi.advanceTimersByTime(299));
    expect(setSearchParams).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTime(1));

    expect(setSearchParams).toHaveBeenCalledTimes(1);
    const [updater, options] = setSearchParams.mock.calls[0];
    const next = updater(new URLSearchParams("page=2"));
    expect(next.get("q")).toBe("charizard");
    expect(next.has("search")).toBe(false);
    expect(next.has("page")).toBe(false);
    expect(options).toMatchObject({ preventScrollReset: true, replace: true });
  });

  it("commits rapid price edits once with the settled values", async () => {
    vi.useFakeTimers();
    const setSearchParams = vi.fn();
    mockUseLoaderData.mockReturnValue(searchData());
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("page=2"), setSearchParams]);

    render(<SearchRoute />);

    const minimumPrice = screen.getByRole("spinbutton", { name: "Minimum price" });
    fireEvent.change(minimumPrice, { target: { value: "1" } });
    fireEvent.change(minimumPrice, { target: { value: "15" } });
    fireEvent.change(minimumPrice, { target: { value: "150" } });

    await act(() => vi.advanceTimersByTime(PRICE_FILTER_DEBOUNCE_MS - 1));
    expect(setSearchParams).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTime(1));

    expect(setSearchParams).toHaveBeenCalledTimes(1);
    const [updater, options] = setSearchParams.mock.calls[0];
    const next = updater(new URLSearchParams("page=2"));
    expect(next.get("priceMin")).toBe("150.00");
    expect(next.has("priceMax")).toBe(false);
    expect(next.has("page")).toBe(false);
    expect(options).toMatchObject({ preventScrollReset: true, replace: true });
  });

  it("flushes a pending price edit when the field loses focus", () => {
    vi.useFakeTimers();
    const setSearchParams = vi.fn();
    mockUseLoaderData.mockReturnValue(searchData());
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("page=2"), setSearchParams]);

    render(<SearchRoute />);

    const minimumPrice = screen.getByRole("spinbutton", { name: "Minimum price" });
    fireEvent.change(minimumPrice, { target: { value: "150" } });
    fireEvent.focusOut(minimumPrice);

    expect(setSearchParams).toHaveBeenCalledTimes(1);
    const [updater] = setSearchParams.mock.calls[0];
    expect(updater(new URLSearchParams("page=2")).get("priceMin")).toBe("150.00");
  });

  it("flushes the pending search immediately when Enter submits", async () => {
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
    await act(() => vi.advanceTimersByTime(300));
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

  it("keeps search focused when the hero changes to the results toolbar", async () => {
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

    await act(() => vi.advanceTimersByTime(300));
    loaderData = searchData("c");
    rerender(<SearchRoute />);

    const toolbarInput = screen.getByRole("searchbox") as HTMLInputElement;
    expect(toolbarInput.value).toBe("c");
    expect(document.activeElement).toBe(toolbarInput);
  });

  it("clearing search removes search and page params", async () => {
    vi.useFakeTimers();
    const setSearchParams = vi.fn();
    mockUseLoaderData.mockReturnValue(searchData("pikachu"));
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu&page=3"), setSearchParams]);

    render(<SearchRoute />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    await act(() => vi.advanceTimersByTime(300));

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
    fireEvent.click(
      within(screen.getByRole("complementary", { name: "Desktop search filters" })).getByRole("button", {
        name: "Language",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Japanese" }));

    const [updater, options] = setSearchParams.mock.calls[0];
    const next = updater(new URLSearchParams("q=pikachu&page=3"));
    expect(next.get("q")).toBe("pikachu");
    expect(next.get("language")).toBe("ja");
    expect(next.has("page")).toBe(false);
    expect(options).toMatchObject({ preventScrollReset: true, replace: false });
  });

  describe("search interpretation", () => {
    const company = "dimension.dim_seed_grading_company";
    const grade = "dimension.dim_seed_grade";
    const interpretation = {
      remainingQuery: "charizard",
      applied: [
        { param: company, optionId: "psa", label: "PSA" },
        { param: grade, optionId: "gm10", label: "Gem Mint 10" },
        { param: grade, optionId: "test10", label: "Test Ten" },
        { param: "language", language: "ja", label: "Japanese" },
      ],
    };
    function stubSearchApi(response: Record<string, unknown>) {
      const requests: URL[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/categories")) return Response.json({ items: [], total: 0, count: 0 });
          requests.push(url);
          return Response.json({
            items: [],
            facets: [],
            total: 0,
            count: 0,
            nextCursor: null,
            retrievalMode: "lexical",
            lexicalCount: 0,
            ...response,
          });
        }),
      );
      return requests;
    }
    const load = (url: string, params: Record<string, string> = {}) =>
      loader({ request: new Request(url), params, context: {} } as unknown as Parameters<typeof loader>[0]);

    it("redirects once to the canonical URL with newly applied keys and every other param", async () => {
      const requests = stubSearchApi({ interpretation });
      const thrown = await load(
        "http://localhost/search?q=charzard+psa+10+japanese&sort=newest&dimension.dim_finish=foil",
      ).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(Response);
      const response = thrown as Response;
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location") ?? "", "http://localhost");
      expect(location.pathname).toBe("/search");
      expect(location.searchParams.get("q")).toBe("charizard");
      expect(location.searchParams.get("sort")).toBe("newest");
      expect(location.searchParams.getAll("dimension.dim_finish")).toEqual(["foil"]);
      expect(location.searchParams.getAll(company)).toEqual(["psa"]);
      expect(location.searchParams.getAll(grade)).toEqual(["gm10", "test10"]);
      expect(location.searchParams.get("language")).toBe("ja");
      expect(location.searchParams.get("interpreted")).toBe(`${company},${grade},language`);
      expect(requests.filter((url) => url.pathname.endsWith("/items"))).toHaveLength(1);
      expect(requests[0]?.searchParams.has("interpreted")).toBe(false);
    });

    it("forwards the marker to the dispatcher and never redirects a marked URL", async () => {
      const requests = stubSearchApi({ interpretation });
      const result = await load(`http://localhost/search?q=charizard&${company}=psa&interpreted=${company}`);
      expect(result).toMatchObject({ search: "charizard", interpreted: company, interpretedFilters: [company] });
      expect(requests[0]?.searchParams.get("interpreted")).toBe(company);
    });

    it.each([
      ["a marked page loads more under its marker", `${grade},language`, `${grade},language`],
      ["an empty marker still loads more under its marker", "", ""],
      ["an unmarked page loads more without a marker", null, null],
    ])("%s", async (_name, marker, expected) => {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
        Response.json({ items: [], facets: [], total: null, count: 0, nextCursor: null, retrievalMode: "lexical" }),
      );
      vi.stubGlobal("fetch", fetchMock);
      mockUseLoaderData.mockReturnValue({
        ...searchDataWithCursor("charizard"),
        interpreted: marker,
        interpretedFilters: marker?.split(",") ?? [],
      });
      mockUseNavigate.mockReturnValue(vi.fn());
      mockUseNavigation.mockReturnValue({ state: "idle" });
      mockUseSearchParams.mockReturnValue([new URLSearchParams("q=charizard"), vi.fn()]);

      render(<SearchRoute />);
      fireEvent.click(screen.getByRole("button", { name: "Load more results" }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const requested = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
      expect(requested.searchParams.get("cursor")).toBe("cursor_2");
      expect(requested.searchParams.get("interpreted")).toBe(expected);
    });

    it("an uninterpreted response renders without a redirect or notice keys", async () => {
      stubSearchApi({});
      await expect(load("http://localhost/search?q=charizard")).resolves.toMatchObject({ interpretedFilters: [] });
    });

    it.each([
      ["removing a marked chip keeps the marker", "Remove Grade: Gem Mint 10", true],
      ["removing the marked language keeps the marker", "Remove Language: Japanese", true],
    ])("%s", (_name, button, kept) => {
      const setSearchParams = vi.fn();
      const current = new URLSearchParams(`q=charizard&language=ja&${grade}=gm10&interpreted=${grade},language`);
      mockUseLoaderData.mockReturnValue({
        ...searchDataWithResults("charizard", "ja"),
        dynamicFilters: [{ kind: "dimension", id: "dim_seed_grade", value: "gm10" }],
        interpretedFilters: [grade, "language"],
        data: {
          ...searchDataWithResults("charizard", "ja").data,
          facets: [
            {
              id: "dim_seed_grade",
              kind: "dimension",
              label: "Grade",
              values: [{ id: "gm10", label: "Gem Mint 10", count: 1, selected: true }],
            },
          ],
        },
      });
      mockUseNavigate.mockReturnValue(vi.fn());
      mockUseNavigation.mockReturnValue({ state: "idle" });
      mockUseSearchParams.mockReturnValue([current, setSearchParams]);

      render(<SearchRoute />);
      expect(screen.getByText("Filters applied from your search: Grade: Gem Mint 10, Japanese")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: button }));
      const next = setSearchParams.mock.calls[0][0](new URLSearchParams(current));
      expect(next.get("interpreted")).toBe(kept ? `${grade},language` : null);
    });

    it.each(["a new query", "an added filter"] as const)("%s drops the marker", (change) => {
      const setSearchParams = vi.fn();
      const current = new URLSearchParams(`q=charizard&${grade}=gm10&interpreted=${grade}`);
      mockUseLoaderData.mockReturnValue({ ...searchDataWithResults("charizard"), interpretedFilters: [grade] });
      mockUseNavigate.mockReturnValue(vi.fn());
      mockUseNavigation.mockReturnValue({ state: "idle" });
      mockUseSearchParams.mockReturnValue([current, setSearchParams]);

      render(<SearchRoute />);
      if (change === "a new query") {
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "blastoise" } });
        fireEvent.submit(screen.getByRole("search"));
      } else {
        fireEvent.click(
          within(screen.getByRole("complementary", { name: "Desktop search filters" })).getByRole("button", {
            name: "Language",
          }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Japanese" }));
      }
      const next = setSearchParams.mock.calls[0][0](new URLSearchParams(current));
      expect(next.has("interpreted")).toBe(false);
      expect(next.getAll(grade)).toEqual(["gm10"]);
    });

    describe("marked and unmarked Result Sets", () => {
      // The same words and filters under each retrieval policy; only the marker differs.
      const lexical = ["cat_lexical", "lexical-charizard", "Lexical Charizard"] as const;
      const lexicalNext = ["cat_lexical_next", "lexical-charizard-2", "Lexical Charizard 2"] as const;
      const semanticOnly = ["cat_semantic", "semantic-only-charizard", "Semantic-only Charizard"] as const;
      let routeData: ReturnType<typeof policyData>;

      function policyData(
        interpreted: string | null,
        rows: ReadonlyArray<readonly [string, string, string]>,
        nextCursor: string | null,
      ) {
        return {
          ...searchData("charizard"),
          dynamicFilters: [{ kind: "dimension" as const, id: "dim_seed_grade", value: "gm10" }],
          interpreted,
          interpretedFilters: (interpreted ?? "").split(",").filter(Boolean),
          data: resultPage(rows, nextCursor),
        };
      }

      function show(data: ReturnType<typeof policyData>) {
        routeData = data;
        mockUseLoaderData.mockImplementation(() => routeData);
        mockUseNavigate.mockReturnValue(vi.fn());
        mockUseNavigation.mockReturnValue({ state: "idle" });
        mockUseSearchParams.mockReturnValue([new URLSearchParams(`q=charizard&${grade}=gm10`), vi.fn()]);
        return render(<SearchRoute />);
      }

      function revisit(
        view: ReturnType<typeof render>,
        mode: "mounted" | "remounted",
        data: ReturnType<typeof policyData>,
      ) {
        routeData = data;
        if (mode === "mounted") {
          view.rerender(<SearchRoute />);
        } else {
          view.unmount();
          render(<SearchRoute />);
        }
      }

      function stubPages(pages: Record<string, DiscoverySearchResponse>) {
        const requests: URL[] = [];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input), "http://localhost");
            requests.push(url);
            const page = pages[url.searchParams.get("cursor") ?? ""];
            if (!page) {
              throw new Error(`Unexpected search request ${url.search}`);
            }
            return jsonResponse(page);
          }),
        );
        return requests;
      }

      async function loadMore(expected: readonly string[]) {
        fireEvent.click(screen.getByRole("button", { name: "Load more results" }));
        await waitFor(() => expect(renderedItemSlugs()).toEqual(expected));
      }

      it.each([
        ["mounted", "a marked page", grade, [lexical], ["lexical-charizard"]],
        ["remounted", "a marked page", grade, [lexical], ["lexical-charizard"]],
        ["mounted", "a final-empty marked page", grade, [], []],
        ["remounted", "a final-empty marked page", grade, [], []],
        ["mounted", "an empty-marker page", "", [lexical], ["lexical-charizard"]],
        ["remounted", "an empty-marker page", "", [lexical], ["lexical-charizard"]],
      ] as const)(
        "a %s route shows %s without the unmarked pages it loaded",
        async (mode, _name, marker, rows, expected) => {
          const requests = stubPages({ "hybrid-2": resultPage([semanticOnly], null) });
          const view = show(policyData(null, [lexical], "hybrid-2"));
          await loadMore(["lexical-charizard", "semantic-only-charizard"]);
          expect(requests[0]?.searchParams.has("interpreted")).toBe(false);

          revisit(view, mode, policyData(marker, rows, null));

          expect(renderedItemSlugs()).toEqual(expected);
        },
      );

      it.each(["mounted", "remounted"] as const)(
        "a %s route drops the marked pages it loaded when the marker is dropped",
        async (mode) => {
          const requests = stubPages({ "lexical-2": resultPage([lexicalNext], null) });
          const view = show(policyData(grade, [lexical], "lexical-2"));
          await loadMore(["lexical-charizard", "lexical-charizard-2"]);
          expect(requests[0]?.searchParams.get("interpreted")).toBe(grade);

          revisit(view, mode, policyData(null, [lexical, semanticOnly], null));

          expect(renderedItemSlugs()).toEqual(["lexical-charizard", "semantic-only-charizard"]);
        },
      );

      it("discards an unmarked load-more that answers after a marker-only navigation", async () => {
        let answer: (page: DiscoverySearchResponse) => void = () => undefined;
        const fetchMock = vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              answer = (page) => resolve(jsonResponse(page));
            }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const view = show(policyData(null, [lexical], "hybrid-2"));
        fireEvent.click(screen.getByRole("button", { name: "Load more results" }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

        revisit(view, "mounted", policyData(grade, [lexical], null));
        await act(async () => {
          answer(resultPage([semanticOnly], null));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(renderedItemSlugs()).toEqual(["lexical-charizard"]);
        revisit(view, "remounted", routeData);
        expect(renderedItemSlugs()).toEqual(["lexical-charizard"]);
      });

      it("restores a marked Result Set's own pages under any marker it is listed with", async () => {
        const requests = stubPages({ "lexical-2": resultPage([lexicalNext], null) });
        const view = show(policyData(grade, [lexical], "lexical-2"));
        await loadMore(["lexical-charizard", "lexical-charizard-2"]);
        expect(requests[0]?.searchParams.get("interpreted")).toBe(grade);

        // The retrieval policy, not the listed keys, identifies the Result Set, as it does for the API.
        revisit(view, "remounted", policyData("", [lexical], "lexical-2"));

        expect(renderedItemSlugs()).toEqual(["lexical-charizard", "lexical-charizard-2"]);
      });
    });
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
            lowest_price_currency_code: "USD",
            active_listing_count: 4,
            total_visible_quantity: 4,
          },
        },
      ],
    } satisfies RealtimeProjectionPatch;

    act(() => subscriptionOptions?.onPatch(patch));

    await waitFor(() => {
      const priceValue = screen.getByText("$7.00");
      expect(priceValue.parentElement).toBeTruthy();
      expect(priceValue.parentElement?.textContent).toBe("From $7.00");
    });
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
});

function payloadOf(value: unknown): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  return typeof record.searchFailed === "boolean" ? record : (record.data as Record<string, unknown>);
}

describe("marketplace search back-navigation restoration", () => {
  it("restores corrected first-page metadata and notice through the actual client loader", async () => {
    const path = "/search?q=pikachu";
    const cached = {
      ...searchDataWithResults("pikachu"),
      data: {
        ...searchDataWithResults("pikachu").data,
        retrievalMode: "corrected" as const,
        lexicalCount: 0,
        nextCursor: null,
      },
    };
    cacheSearchLoaderData(window.sessionStorage, searchLoaderCacheKey(path), cached);
    const serverLoader = vi.fn();
    const restored = await clientLoader({
      request: new Request(`http://localhost${path}`),
      serverLoader,
    } as unknown as Parameters<typeof clientLoader>[0]);
    mockUseLoaderData.mockReturnValue(restored);
    mockUseNavigate.mockReturnValue(vi.fn());
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("q=pikachu"), vi.fn()]);
    render(<SearchRoute />);
    expect(screen.getByText("No exact matches for pikachu. Showing close spellings.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more results" })).toBeNull();
    expect(serverLoader).not.toHaveBeenCalled();
    expect(readCachedSearchLoaderData(window.sessionStorage, searchLoaderCacheKey(path))).toEqual(cached);
  });
  beforeEach(() => {
    mockUseLocation.mockReturnValue({ pathname: "/search", search: "?q=pikachu", hash: "", state: null, key: "test" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn(), state: "idle" });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    "q=charizard+ex",
    "q=charizard+ex&sort=price_asc&dimension.finish=foil",
    "q=charizard+ex&sort=price_desc&dimension.finish=foil",
  ])(
    "replaces a restored old-order page and metadata when a cursor restarts; stored copies cannot revive it (%s)",
    async (query) => {
      mockUseLocation.mockReturnValue({
        pathname: "/search",
        search: `?${query}`,
        hash: "",
        state: null,
        key: "restart",
      });
      const loaderCacheKey = searchLoaderCacheKey(`/search?${query}`);
      const staleFacet = {
        id: "condition",
        kind: "dimension" as const,
        label: "Stale condition",
        values: [{ id: "mint", label: "Stale mint", count: 40, selected: false }],
      };
      // Restored pre-deploy state: non-exact first, stale facets/total, rescue mode and notice.
      const oldLoaderData = {
        ...searchData("charizard ex"),
        data: {
          ...resultPage([["cat_box", "charizard-ex-box", "Charizard ex Box"]], "legacy-cursor-1"),
          facets: [staleFacet],
          category_counts: [{ slug: "cards", count: 40 }],
          total: 40,
          retrievalMode: "rescue" as const,
          lexicalCount: 1,
        },
      };
      cacheSearchLoaderData(window.sessionStorage, loaderCacheKey, oldLoaderData);
      persistSearchRestoration(
        window.sessionStorage,
        resultSetKey(oldLoaderData),
        [resultPage([["cat_old", "old-lizardon", "Old Lizardon"]], "legacy-cursor-2")],
        0,
      );
      const restarted = {
        ...resultPage(
          [
            ["cat_exact", "charizard-ex", "Charizard ex"],
            ["cat_box", "charizard-ex-box", "Charizard ex Box"],
          ],
          "v2-cursor",
        ),
        facets: [{ ...staleFacet, label: "Fresh condition" }],
        category_counts: [{ slug: "cards", count: 3 }],
        total: 3,
        cursorRestarted: true as const,
      };
      const continuation = resultPage([["cat_vmax", "charizard-vmax", "Charizard VMAX"]], null);
      const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
        jsonResponse(String(input).includes("cursor=v2-cursor") ? continuation : restarted),
      );
      vi.stubGlobal("fetch", fetchMock);
      const navigateBack = () =>
        clientLoader({
          request: new Request(`http://localhost/search?${query}`),
          params: {},
          context: {},
          serverLoader: vi.fn(async () => {
            throw new Error("A fresh cached Result Set must not refetch.");
          }),
        } as unknown as Parameters<typeof clientLoader>[0]);
      mockUseLoaderData.mockReturnValue(await navigateBack());
      mockUseNavigate.mockReturnValue(vi.fn());
      mockUseNavigation.mockReturnValue({ state: "idle" });
      mockUseSearchParams.mockReturnValue([new URLSearchParams(query), vi.fn()]);

      const restoredVisit = render(<SearchRoute />);
      expect(renderedItemSlugs()).toEqual(["charizard-ex-box", "old-lizardon"]);
      expect(screen.getByText("Closest matches")).toBeTruthy();
      expect(screen.getAllByText("Stale condition").length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole("button", { name: "Load more results" }));

      await waitFor(() => expect(renderedItemSlugs()).toEqual(["charizard-ex", "charizard-ex-box"]));
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("cursor=legacy-cursor-2");
      expect(screen.queryByText("Closest matches")).toBeNull();
      expect(screen.queryAllByText("Stale condition")).toHaveLength(0);
      expect(screen.getAllByText("Fresh condition").length).toBeGreaterThan(0);
      expect(screen.getAllByText(/of 3 results/).length).toBeGreaterThan(0);
      expect(screen.queryAllByText(/40 results/)).toHaveLength(0);

      // Valid v2 pages append after the replacement.
      fireEvent.click(screen.getByRole("button", { name: "Load more results" }));
      await waitFor(() => expect(renderedItemSlugs()).toEqual(["charizard-ex", "charizard-ex-box", "charizard-vmax"]));
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=v2-cursor");
      expect(readCachedSearchLoaderData(window.sessionStorage, loaderCacheKey)).toMatchObject({
        data: { total: 3, retrievalMode: "lexical", nextCursor: "v2-cursor" },
      });
      expect(readCachedSearchLoaderData(window.sessionStorage, loaderCacheKey)).not.toMatchObject({
        data: { cursorRestarted: true },
      });

      // Back navigation replays both stored copies: neither revives the old page, metadata, or notice.
      restoredVisit.unmount();
      mockUseLoaderData.mockReturnValue(await navigateBack());
      render(<SearchRoute />);

      expect(renderedItemSlugs()).toEqual(["charizard-ex", "charizard-ex-box", "charizard-vmax"]);
      expect(screen.queryByText("Closest matches")).toBeNull();
      expect(screen.queryAllByText("Stale condition")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Load more results" })).toBeNull();
    },
  );

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
    interpreted: false,
  });
}

function resultPage(
  items: ReadonlyArray<readonly [catalogItemId: string, slug: string, title: string]>,
  nextCursor: string | null,
): DiscoverySearchResponse {
  const template = persistedSearchPage("template", "template", "Template");
  const [item] = template.items;
  if (!item) {
    throw new Error("Expected a search result fixture.");
  }

  return {
    ...template,
    items: items.map(([catalogItemId, slug, title]) => ({
      ...item,
      catalog_item_id: catalogItemId,
      slug,
      title,
      subtitle: null,
    })),
    count: items.length,
    nextCursor,
  };
}

function renderedItemSlugs(): string[] {
  const slugs = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/items/"]')].map(
    (anchor) => new URL(anchor.getAttribute("href") ?? "", "http://localhost").pathname.split("/")[2] ?? "",
  );
  return [...new Set(slugs)];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
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
    queryHash: "",
    resultSetKey: "",
  };
}
