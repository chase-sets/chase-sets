import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { SearchPage } from "@chase-sets/discovery/web";

describe("SearchPage", () => {
  it("applies a category without issuing a second page reset", () => {
    const onCategoryChange = vi.fn();
    const onPageChange = vi.fn();

    render(
      <MemoryRouter>
        <SearchPage
          search=""
          category=""
          sort="relevance"
          page={2}
          data={{
            total: 1,
            count: 1,
            items: [
              {
                item_id: "item-1",
                title: "Charizard ex",
                subtitle: "Illustration Rare",
                description: "Classic fire-breathing favorite",
                blueprint_id: "bp-1",
                blueprint_name: "Pokemon Card",
                status: "active",
                category_names: ["Pokemon"],
                tags: ["fire"],
                image_urls: [],
                market_summary: {
                  lowest_price_amount: "24.99",
                  active_listing_count: 2,
                  total_visible_quantity: 3,
                },
                updated_at: "2026-03-31T00:00:00.000Z",
              },
            ],
          }}
          categories={[
            {
              category_id: "cat_pokemon",
              key: "pokemon",
              name: "Pokemon",
              description: "Pokemon cards",
              status: "active",
              parent_category_id: null,
              display_order: 0,
              item_count: 1,
              updated_at: "2026-03-31T00:00:00.000Z",
            },
          ]}
          onSearchChange={() => undefined}
          onCategoryChange={onCategoryChange}
          onSortChange={() => undefined}
          onPageChange={onPageChange}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pokemon (1)" }));

    expect(onCategoryChange).toHaveBeenCalledTimes(1);
    expect(onCategoryChange).toHaveBeenCalledWith("Pokemon");
    expect(onPageChange).not.toHaveBeenCalled();
  });
});
