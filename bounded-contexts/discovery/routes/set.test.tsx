// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryBrowseSetPage } from "../features/browse/api/contracts";

const { getSetBySlug } = vi.hoisted(() => ({ getSetBySlug: vi.fn() }));

vi.mock("../support/request-support/api-client", async (importOriginal) => ({
  ...(await importOriginal()),
  createDiscoveryRequestApiClient: vi.fn(() => ({ getSetBySlug })),
}));

import DiscoverySetRoute, { loader as setLoader } from "./set";

afterEach(cleanup);
beforeEach(() => getSetBySlug.mockReset());

function page(overrides: Partial<DiscoveryBrowseSetPage> = {}): DiscoveryBrowseSetPage {
  return {
    reference_record_id: "ref_base_set",
    type_key: "expansion",
    key: "base-set",
    slug: "base-set",
    name: "Base Set",
    code: null,
    game: null,
    release_date: null,
    item_count: 3,
    items: [
      {
        catalog_item_id: "item_1",
        slug: "charizard",
        title: "Charizard",
        subtitle: null,
        image_urls: [],
        product_asset_sets: [],
        image_fallback: null,
        market_summary: null,
      },
    ],
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderSet(setPage: DiscoveryBrowseSetPage) {
  getSetBySlug.mockResolvedValue(setPage);
  const Stub = createRoutesStub([
    {
      path: "/sets/:setSlug",
      Component: DiscoverySetRoute,
      loader: setLoader,
    },
  ]);
  return render(<Stub initialEntries={["/sets/base-set"]} />);
}

describe("Discovery set route card count", () => {
  it("renders the reference total beside item_count and preserves browse-all count", async () => {
    renderSet(page({ reference_card_count: 102, code: "base", release_date: "1999-01-09" }));

    expect(await screen.findByText(/3 of 102 cards cataloged · set code base · released January 9, 1999/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse all 3 cards in this set" })).toBeTruthy();
    expect(getSetBySlug).toHaveBeenCalledWith("base-set");
  });

  it("renders the existing not-found state", async () => {
    const Stub = createRoutesStub([
      {
        path: "/sets/:setSlug",
        Component: DiscoverySetRoute,
        loader: () => ({ setPage: null, notFound: true, canonicalUrl: null }),
      },
    ]);

    render(<Stub initialEntries={["/sets/missing"]} />);

    expect(await screen.findByText("Set not found")).toBeTruthy();
    expect(screen.getByText("This set is not available right now.")).toBeTruthy();
  });

  it.each([
    ["null", { reference_card_count: null }],
    ["omitted", {}],
  ])("uses the existing count copy when the total is %s", async (_label, overrides) => {
    renderSet(page(overrides));

    expect(await screen.findByText(/^3 cards$/)).toBeTruthy();
    expect(screen.queryByText(/of \d+ cards cataloged/)).toBeNull();
  });

  it("shows the known total with zero cataloged items and keeps the empty-state recovery", async () => {
    renderSet(page({ item_count: 0, items: [], reference_card_count: 102 }));

    expect(await screen.findByText("0 of 102 cards cataloged")).toBeTruthy();
    expect(screen.getByText("No cards yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse marketplace" })).toBeTruthy();
  });
});
