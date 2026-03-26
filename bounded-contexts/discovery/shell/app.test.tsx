import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplaceApp as App } from "./app";

function createJsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => body,
  } as Response);
}

describe("marketplace app", () => {
  beforeEach(() => {
    window.location.hash = "#/search";
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/marketplace/categories")) {
          return createJsonResponse({ items: [] });
        }

        if (url.includes("/api/marketplace/items?")) {
          return createJsonResponse({
            total: 1,
            items: [
              {
                item_id: "item-1",
                title: "Charizard ex",
                subtitle: "Illustration Rare",
                blueprint_name: "Pokemon Card",
                category_names: ["Pokemon"],
                tags: ["Fire"],
                image_urls: [],
              },
            ],
          });
        }

        if (url.includes("/api/marketplace/items/item-1")) {
          return createJsonResponse({
            item_id: "item-1",
            title: "Charizard ex",
            subtitle: "Illustration Rare",
            description: "Search route transition smoke test.",
            blueprint: { blueprintId: "bp-1", name: "Pokemon Card" },
            categories: [{ categoryId: "cat-1", name: "Pokemon" }],
            tags: ["Fire"],
            image_urls: [],
            updated_at: "2026-03-09T00:00:00.000Z",
            field_values: [{ fieldName: "Number", value: "199/165" }],
            version_schema: null,
          });
        }

        return Promise.reject(new Error(`Unhandled fetch request: ${url}`));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("switches between search and item detail routes under the marketplace shell", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Marketplace")).toBeTruthy();
      expect(screen.getByText("Charizard ex")).toBeTruthy();
    });

    await act(async () => {
      window.location.hash = "#/items/item-1";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await waitFor(() => {
      expect(screen.getByText("Search route transition smoke test.")).toBeTruthy();
      expect(screen.getByText("Info")).toBeTruthy();
    });
  });
});


