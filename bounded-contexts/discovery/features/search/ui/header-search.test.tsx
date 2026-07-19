// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("shows the query submit row first and records only that query", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [], count: 0 })),
    );
    renderSearch();

    const searchbox = screen.getByRole("combobox", { name: "Search marketplace" });
    await user.click(searchbox);
    fireEvent.change(searchbox, { target: { value: "char" } });

    const queryOption = await screen.findByRole("option", { name: "Search for 'char'" });
    expect(screen.getAllByRole("option")[0]).toBe(queryOption);
    await user.click(queryOption);

    await waitFor(() => expect(screen.getByLabelText("Current location").textContent).toBe("/search?q=char"));
    expect(JSON.parse(window.localStorage.getItem(MARKETPLACE_RECENT_SEARCHES_STORAGE_KEY) ?? "[]")).toEqual(["char"]);
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
