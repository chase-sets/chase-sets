// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation, MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { MarketplaceHeaderSearch, MARKETPLACE_RECENT_SEARCHES_STORAGE_KEY } from "./header-search";

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current location">{`${location.pathname}${location.search}`}</output>;
}

function renderSearch() {
  return render(
    <MemoryRouter initialEntries={["/items/charizard-ex-cat-1"]}>
      <ChaseRoot linkComponent={RouterLinkAdapter}>
        <MarketplaceHeaderSearch />
        <LocationProbe />
      </ChaseRoot>
    </MemoryRouter>,
  );
}

describe("MarketplaceHeaderSearch", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens the selected item detail without recording a recent search", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        items: [
          {
            catalogItemId: "cat_1",
            title: "Acerola's Mischief 113/132",
            subtitle: "Parallel Set - Reverse Foil",
            slug: "acerolas-mischief-113-132-reverse-foil-cat-1",
            category: "Pokemon TCG",
          },
          {
            catalogItemId: "cat_2",
            title: "Acerola's Mischief 113/132",
            subtitle: "Standard Set",
            slug: "acerolas-mischief-113-132-standard-cat-2",
            category: "Pokemon TCG",
          },
        ],
        count: 1,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    renderSearch();

    const searchbox = screen.getByRole("combobox", { name: "Search marketplace" });
    await user.click(searchbox);
    fireEvent.change(searchbox, { target: { value: "acer" } });
    expect(fetch).not.toHaveBeenCalled();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/marketplace/items/suggest?q=acer");
    const suggestions = await screen.findAllByRole("option", { name: /Acerola's Mischief 113\/132/ });
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]?.textContent).toContain("Parallel Set - Reverse Foil");
    expect(suggestions[1]?.textContent).toContain("Standard Set");

    await user.click(suggestions[0]);

    await waitFor(() =>
      expect(screen.getByLabelText("Current location").textContent).toBe(
        "/items/acerolas-mischief-113-132-reverse-foil-cat-1",
      ),
    );
    expect(window.localStorage.getItem(MARKETPLACE_RECENT_SEARCHES_STORAGE_KEY)).toBeNull();
  });

  it.each(["char", "ETB", "zard 4/102"])(
    "shows the original query submit row first and records only %s",
    async (query) => {
      const user = userEvent.setup();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ items: [], count: 0 })),
      );
      renderSearch();

      const searchbox = screen.getByRole("combobox", { name: "Search marketplace" });
      await user.click(searchbox);
      fireEvent.change(searchbox, { target: { value: query } });

      const queryOption = await screen.findByRole("option", { name: `Search for '${query}'` });
      expect(screen.getAllByRole("option")[0]).toBe(queryOption);
      await user.click(queryOption);

      await waitFor(() =>
        expect(screen.getByLabelText("Current location").textContent).toBe(`/search?q=${encodeURIComponent(query)}`),
      );
      expect(JSON.parse(window.localStorage.getItem(MARKETPLACE_RECENT_SEARCHES_STORAGE_KEY) ?? "[]")).toEqual([query]);
    },
  );

  it("aborts stale synonym requests, ignores late results and empties failed suggestions", async () => {
    let finishStale!: (response: Response) => void;
    const fetch = vi
      .fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishStale = resolve;
          }),
      )
      .mockResolvedValueOnce(
        Response.json({
          items: [{ catalogItemId: "new", title: "Charizard", subtitle: null, slug: "charizard", category: null }],
          count: 1,
        }),
      )
      .mockRejectedValueOnce(new Error("suggestions unavailable"));
    vi.stubGlobal("fetch", fetch);
    renderSearch();
    const user = userEvent.setup();
    const searchbox = screen.getByRole("combobox", { name: "Search marketplace" });
    await user.click(searchbox);
    fireEvent.change(searchbox, { target: { value: "ETB" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.change(searchbox, { target: { value: "zard" } });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await screen.findByRole("option", { name: "Charizard" });
    await act(async () => {
      finishStale(
        Response.json({
          items: [{ catalogItemId: "old", title: "Stale Trainer Box", subtitle: null, slug: "old", category: null }],
          count: 1,
        }),
      );
    });
    await waitFor(() => expect(screen.queryByRole("option", { name: "Stale Trainer Box" })).toBeNull());
    fireEvent.change(searchbox, { target: { value: "pkmn" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole("option", { name: "Charizard" })).toBeNull());
    expect(screen.getByRole("option", { name: "Search for 'pkmn'" })).toBeTruthy();
  });

  it("loads persisted recent searches and clears them from the keyboard-accessible list", async () => {
    window.localStorage.setItem(MARKETPLACE_RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(["pikachu", "charizard"]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [], count: 0 })),
    );
    const user = userEvent.setup();
    renderSearch();

    await user.click(screen.getByRole("combobox", { name: "Search marketplace" }));
    const listbox = await screen.findByRole("listbox", { name: "Search marketplace" });

    expect(within(listbox).getByRole("option", { name: /pikachu/i })).toBeTruthy();
    expect(within(listbox).getByRole("option", { name: /charizard/i })).toBeTruthy();
    await user.click(within(listbox).getByRole("option", { name: "Clear recent searches" }));

    expect(window.localStorage.getItem(MARKETPLACE_RECENT_SEARCHES_STORAGE_KEY)).toBeNull();
    await waitFor(() => expect(screen.queryByRole("option", { name: /pikachu/i })).toBeNull());
  });
});
