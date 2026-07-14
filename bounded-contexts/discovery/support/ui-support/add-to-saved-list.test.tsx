// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavedListPickerPreparation } from "./saved-list-contracts";
import { AddToSavedListControl } from "./add-to-saved-list";

const preparation: SavedListPickerPreparation = {
  product: {
    catalogItemId: "cat_card",
    productId: "cat_card::condition:near-mint",
    selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
  },
  productLabel: "Pikachu · Near Mint",
  recentLists: [
    {
      listId: "svl_favorites",
      title: "Favorites",
      lineCount: 2,
      trackedUnitCount: 3,
      version: 4,
      changedAt: "2026-07-13T12:00:00.000Z",
    },
  ],
  tokens: {
    addCommandId: "slc_add",
    lineId: "sll_card",
    newListId: "svl_new",
    newListCommandId: "slc_new",
  },
  sourceSurface: "search",
  claimIntentId: null,
  resumeDestination: null,
  resumeTrackedQuantity: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Add to Saved List control", () => {
  it("renders the localized recent-List picker from prepared Collections data", () => {
    render(
      <AddToSavedListControl
        productKey={preparation.product.productId}
        productLabel={preparation.productLabel}
        prepareFields={{ slug: "pikachu" }}
        initialPreparation={preparation}
      />,
    );

    expect(screen.getByRole("heading", { name: "Add to List" })).not.toBeNull();
    expect(screen.getByText("Pikachu · Near Mint")).not.toBeNull();
    expect(screen.getByText("Favorites")).not.toBeNull();
    expect(screen.getByText("2 lines · 3 tracked")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add Product" }).hasAttribute("disabled")).toBe(false);
  });

  it("ignores a preparation response after the visible Product changes", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const view = render(
      <AddToSavedListControl
        productKey="cat_card::condition:near-mint"
        productLabel="Pikachu · Near Mint"
        prepareFields={{ slug: "pikachu" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Pikachu · Near Mint to a Saved List" }));
    view.rerender(
      <AddToSavedListControl
        productKey="cat_card::condition:lightly-played"
        productLabel="Pikachu · Lightly Played"
        prepareFields={{ slug: "pikachu" }}
      />,
    );
    await act(async () => {
      resolveFetch?.(
        new Response(JSON.stringify({ status: "ready", preparation }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Add to List" })).toBeNull());
  });
});
