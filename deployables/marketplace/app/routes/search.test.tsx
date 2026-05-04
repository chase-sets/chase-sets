import { act, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockUseLoaderData,
  mockUseNavigate,
  mockUseNavigation,
  mockUseSearchParams,
} = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseNavigate: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockUseSearchParams: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useNavigate: mockUseNavigate,
    useNavigation: mockUseNavigation,
    useSearchParams: mockUseSearchParams,
  };
});

vi.mock("@chase-sets/platform-runtime/realtime-web", () => ({
  createRealtimeRouteSubscriptionPreset: vi.fn((id, topics) => ({ id, topics })),
  subscribeRealtimePatches: vi.fn(() => ({ close: vi.fn() })),
}));

import SearchRoute from "@chase-sets/discovery/routes/search";

function searchData(search = "") {
  return {
    search,
    category: "",
    sort: "relevance",
    page: 1,
    data: { items: [], total: 0, count: 0, nextCursor: null },
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

describe("marketplace search route", () => {
  afterEach(() => {
    vi.clearAllMocks();
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
    expect(next.get("search")).toBe("charizard");
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
    mockUseSearchParams.mockReturnValue([new URLSearchParams("search=pikachu&page=3"), setSearchParams]);

    render(<SearchRoute />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    act(() => vi.advanceTimersByTime(300));

    const [updater] = setSearchParams.mock.calls[0];
    const next = updater(new URLSearchParams("search=pikachu&page=3"));
    expect(next.has("search")).toBe(false);
    expect(next.has("page")).toBe(false);
  });

  it("navigates category changes without forcing a document reload", () => {
    const navigate = vi.fn();
    mockUseLoaderData.mockReturnValue(searchData("pikachu"));
    mockUseNavigate.mockReturnValue(navigate);
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams("search=pikachu&page=3"), vi.fn()]);

    render(<SearchRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Cards (2)" }));

    expect(navigate).toHaveBeenCalledWith("/categories/cards?search=pikachu", {
      preventScrollReset: true,
    });
  });
});
