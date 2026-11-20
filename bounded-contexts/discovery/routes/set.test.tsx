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

import { createDiscoveryRequestApiClient, DiscoveryApiError } from "../support/request-support/api-client";
import DiscoverySetRoute, { loader as setLoader, meta as setMeta } from "./set";

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

    expect(
      await screen.findByText("Cards in set: 102 · Cataloged items: 3 · set code base · released January 9, 1999"),
    ).toBeTruthy();
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
    ["known", { reference_card_count: 102 }, "Cards in set: 102 · Cataloged items: 3"],
    ["null", { reference_card_count: null }, "Cataloged items: 3"],
    ["omitted", {}, "Cataloged items: 3"],
    ["one", { reference_card_count: 1, item_count: 1 }, "Cards in set: 1 · Cataloged items: 1"],
    ["over-count", { reference_card_count: 102, item_count: 216 }, "Cards in set: 102 · Cataloged items: 216"],
  ])("renders independent counts for %s", async (_label, overrides, expected) => {
    renderSet(page(overrides));

    expect(await screen.findByText(expected)).toBeTruthy();
    if (_label === "over-count") {
      expect(screen.getByRole("link", { name: "Browse all 216 cards in this set" })).toBeTruthy();
    }
  });

  it("shows the known total with zero cataloged items and keeps the empty-state recovery", async () => {
    renderSet(page({ item_count: 0, items: [], reference_card_count: 102 }));

    expect(await screen.findByText("Cards in set: 102 · Cataloged items: 0")).toBeTruthy();
    expect(screen.getByText("No cards yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse marketplace" })).toBeTruthy();
  });

  it("renders unknown total with zero cataloged items", async () => {
    renderSet(page({ item_count: 0, items: [], reference_card_count: null }));

    expect(await screen.findByText("Cataloged items: 0")).toBeTruthy();
  });
});

/** The set read answers `status`; a plain function, since a spy reports the rejection it returned as the test's failure. */
function failRead(status: number) {
  vi.mocked(createDiscoveryRequestApiClient).mockReturnValueOnce({
    getSetBySlug: async () => {
      throw new DiscoveryApiError(status, { error: { code: "failed", message: "Failed" } });
    },
  } as never);
}

function load(slug = "no-such-set") {
  return setLoader({
    request: new Request(`http://localhost/sets/${slug}`),
    params: { setSlug: slug },
    context: {},
  } as never);
}

describe("Discovery set route status", () => {
  it("answers a set the API does not have with 404, noindex and no canonical link", async () => {
    failRead(404);

    const result = (await load()) as unknown as {
      data: { setPage: null; canonicalUrl: null };
      init: { status: number };
    };
    expect(result.init.status).toBe(404);
    expect(result.data).toEqual({ setPage: null, notFound: true, canonicalUrl: null });
    const tags = setMeta({ data: result.data } as never) ?? [];

    expect(tags).toContainEqual({ name: "robots", content: "noindex" });
    expect(tags.some((tag) => "rel" in tag && tag.rel === "canonical")).toBe(false);
  });

  it.each([
    [500, 502],
    [503, 503],
    [400, 502],
  ])("answers a set read the API fails with %i as %i, not as a missing set", async (status, expected) => {
    failRead(status);

    await expect(load()).rejects.toMatchObject({ init: { status: expected } });
  });

  it("keeps a found set indexable", async () => {
    getSetBySlug.mockResolvedValue(page());

    const result = await load("base-set");
    expect(setMeta({ data: result } as never)).not.toContainEqual({ name: "robots", content: "noindex" });
  });
});
