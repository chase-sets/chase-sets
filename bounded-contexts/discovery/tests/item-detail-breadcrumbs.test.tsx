// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";
import { createItem, renderWithDataRouter } from "./item-detail-commerce-panel-test-harness";

afterEach(cleanup);

describe("item detail breadcrumbs", () => {
  it("links the first assigned category between Home and the item", () => {
    renderWithDataRouter(
      <ItemDetailPage
        data={createItem({
          categories: [
            { categoryId: "cat_pokemon", slug: "pokemon-cards", name: "Pokémon cards" },
            { categoryId: "cat_collectibles", slug: "collectibles", name: "Collectibles" },
          ],
        })}
      />,
    );

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Pokémon cards" }).getAttribute("href")).toBe(
      "/categories/pokemon-cards",
    );
    expect(within(breadcrumb).queryByRole("link", { name: "Collectibles" })).toBeNull();
    expect(within(breadcrumb).getByText("Charizard").getAttribute("aria-current")).toBe("page");
  });

  it("links Search when the item has no assigned category", () => {
    renderWithDataRouter(<ItemDetailPage data={createItem({ categories: [] })} />);

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Search" }).getAttribute("href")).toBe("/search");
  });
});
