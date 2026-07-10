// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ItemDetailSimilarItems } from "../features/item-detail/ui/item-detail-similar-items";

afterEach(cleanup);

describe("item detail Similar Items", () => {
  it("renders active neighbor links with design-system listing cards and privacy-safe analytics", () => {
    const events: unknown[] = [];
    window.addEventListener("chase-sets:item-detail-rail-analytics", (event) => {
      events.push((event as CustomEvent).detail);
    });

    render(
      <ItemDetailSimilarItems
        items={[
          {
            catalog_item_id: "charizard-ex",
            slug: "charizard-ex-sv3",
            title: "Charizard ex",
            subtitle: "SV3 066/108",
            image_urls: [],
            product_asset_sets: [],
            image_fallback: null,
          },
        ]}
      />,
    );

    expect(screen.getByRole("heading", { name: "More like this" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "View item" });
    expect(link.getAttribute("href")).toBe("/items/charizard-ex-sv3");
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    expect(events).toEqual([
      {
        event: "similar_item_selected",
        surface: "similar_items",
        selection: "implicit",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("charizard-ex");
  });

  it("omits the section when there are no peers", () => {
    const { container } = render(<ItemDetailSimilarItems items={[]} />);

    expect(container.firstChild).toBeNull();
  });
});
