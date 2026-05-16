// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockUseNavigation,
  mockUseSearchParams,
} = vi.hoisted(() => ({
  mockUseNavigation: vi.fn(),
  mockUseSearchParams: vi.fn(),
}));

vi.mock("react-router", () => ({
  useNavigation: mockUseNavigation,
  useSearchParams: mockUseSearchParams,
}));

import {
  applyCatalogListQueryToSearchParams,
  buildCatalogListApiQuery,
  loadCatalogListRouteData,
  readCatalogListQuery,
  useCatalogListQueryControls,
  type CatalogListQuery,
} from "./list-query-state";

function Harness({ query }: { query: CatalogListQuery }) {
  const controls = useCatalogListQueryControls(query);

  return (
    <>
      <input
        aria-label="Search"
        value={controls.search}
        onChange={(event) => controls.setSearch(event.target.value)}
      />
      <button type="button" onClick={() => controls.setStatus("active")}>
        Active
      </button>
      <button type="button" onClick={() => controls.setLanguage("ja")}>
        Japanese
      </button>
      <button type="button" onClick={() => controls.setSource("tcgplayer")}>
        Source
      </button>
      <button type="button" onClick={() => controls.setSetId("base1")}>
        Base Set
      </button>
      <button type="button" onClick={() => controls.setPage(2)}>
        Page 3
      </button>
    </>
  );
}

describe("catalog list query state", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("reads URL params and builds the API query with limit and offset", () => {
    const query = readCatalogListQuery(
      new Request("http://localhost/catalog-items?search=charizard&status=active&language=ja&source=tcgplayer&setId=base1&page=3"),
    );

    expect(query).toEqual({
      search: "charizard",
      status: "active",
      language: "ja",
      source: "tcgplayer",
      setId: "base1",
      page: 2,
      pageSize: 50,
    });
    expect(buildCatalogListApiQuery(query)).toBe(
      "search=charizard&status=active&language=ja&source=tcgplayer&setId=base1&limit=50&offset=100",
    );
  });

  it("applies search, status, language, source, set, and page updates to URL params", () => {
    const searched = applyCatalogListQueryToSearchParams(
      new URLSearchParams("search=old&page=3"),
      { search: " new " },
    );
    expect(searched.toString()).toBe("search=new");

    const filtered = applyCatalogListQueryToSearchParams(
      new URLSearchParams("search=new&page=2"),
      { status: "active" },
    );
    expect(filtered.toString()).toBe("search=new&status=active");

    const languageFiltered = applyCatalogListQueryToSearchParams(
      new URLSearchParams("search=new&status=active&page=2"),
      { language: "ja" },
    );
    expect(languageFiltered.toString()).toBe("search=new&status=active&language=ja");

    const sourceFiltered = applyCatalogListQueryToSearchParams(
      new URLSearchParams("search=new&status=active&language=ja&page=2"),
      { source: "tcgplayer" },
    );
    expect(sourceFiltered.toString()).toBe("search=new&status=active&language=ja&source=tcgplayer");

    const setFiltered = applyCatalogListQueryToSearchParams(
      new URLSearchParams("search=new&status=active&language=ja&source=tcgplayer&page=2"),
      { setId: "base1" },
    );
    expect(setFiltered.toString()).toBe("search=new&status=active&language=ja&source=tcgplayer&setId=base1");

    const paged = applyCatalogListQueryToSearchParams(
      new URLSearchParams("search=new&status=active&language=ja&source=tcgplayer&setId=base1"),
      { page: 1 },
    );
    expect(paged.toString()).toBe("search=new&status=active&language=ja&source=tcgplayer&setId=base1&page=2");
  });

  it("loads route data through the derived API query", async () => {
    const list = vi.fn(async () => ({ items: [{ id: "item-1" }], total: 1 }));

    const result = await loadCatalogListRouteData(
      new Request("http://localhost/catalog-items?search=charizard&language=en&source=tcgplayer&setId=base1&page=2"),
      list,
    );

    expect(list).toHaveBeenCalledWith("search=charizard&language=en&source=tcgplayer&setId=base1&limit=50&offset=50");
    expect(result.query.search).toBe("charizard");
    expect(result.query.language).toBe("en");
    expect(result.query.source).toBe("tcgplayer");
    expect(result.query.setId).toBe("base1");
    expect(result.data.items).toEqual([{ id: "item-1" }]);
  });

  it("debounces text search and commits filters immediately", () => {
    vi.useFakeTimers();
    const setSearchParams = vi.fn();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([
      new URLSearchParams("search=old&page=3"),
      setSearchParams,
    ]);
    const query = readCatalogListQuery(
      new Request("http://localhost/catalog-items?search=old&page=3"),
    );

    render(<Harness query={query} />);

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "charizard" } });
    act(() => vi.advanceTimersByTime(299));
    expect(setSearchParams).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(setSearchParams).toHaveBeenCalledTimes(1);
    const [searchUpdater, searchOptions] = setSearchParams.mock.calls[0];
    expect(searchUpdater(new URLSearchParams("search=old&page=3")).toString()).toBe(
      "search=charizard",
    );
    expect(searchOptions).toMatchObject({ replace: true });

    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    expect(setSearchParams).toHaveBeenCalledTimes(2);
    const [statusUpdater, statusOptions] = setSearchParams.mock.calls[1];
    expect(statusUpdater(new URLSearchParams("search=charizard&page=3")).toString()).toBe(
      "search=charizard&status=active",
    );
    expect(statusOptions).toMatchObject({ replace: false });

    fireEvent.click(screen.getByRole("button", { name: "Japanese" }));
    expect(setSearchParams).toHaveBeenCalledTimes(3);
    const [languageUpdater, languageOptions] = setSearchParams.mock.calls[2];
    expect(languageUpdater(new URLSearchParams("search=charizard&page=3")).toString()).toBe(
      "search=charizard&language=ja",
    );
    expect(languageOptions).toMatchObject({ replace: false });

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(setSearchParams).toHaveBeenCalledTimes(4);
    const [sourceUpdater, sourceOptions] = setSearchParams.mock.calls[3];
    expect(sourceUpdater(new URLSearchParams("search=charizard&page=3")).toString()).toBe(
      "search=charizard&source=tcgplayer",
    );
    expect(sourceOptions).toMatchObject({ replace: false });

    fireEvent.click(screen.getByRole("button", { name: "Base Set" }));
    expect(setSearchParams).toHaveBeenCalledTimes(5);
    const [setUpdater, setOptions] = setSearchParams.mock.calls[4];
    expect(setUpdater(new URLSearchParams("search=charizard&page=3")).toString()).toBe(
      "search=charizard&setId=base1",
    );
    expect(setOptions).toMatchObject({ replace: false });
  });
});
