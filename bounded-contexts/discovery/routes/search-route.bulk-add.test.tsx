// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, Outlet, RouterProvider, ScrollRestoration } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import type { DiscoveryBulkCartPreview } from "../support/request-support/api-client";
import SearchRoute, { action } from "./search";

const { previewQuery, addCartLines, addGuestCartLines, resolveActor } = vi.hoisted(() => ({
  previewQuery: vi.fn(),
  addCartLines: vi.fn(),
  addGuestCartLines: vi.fn(),
  resolveActor: vi.fn(),
}));
vi.mock("../support/request-support/api-client", () => ({
  createDiscoveryRequestApiClient: () => ({ previewBulkAddSearchResults: previewQuery }),
}));
vi.mock("@chase-sets/checkout/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/checkout/server")>()),
  createCheckoutRequestApiClient: () => ({ addCartLines, addGuestCartLines }),
}));
vi.mock("@chase-sets/platform-runtime/auth", () => ({ resolveActorFromAuthApi: resolveActor }));
vi.mock("@chase-sets/platform-runtime/realtime-web", () => ({
  createRealtimeRouteSubscriptionPreset: vi.fn((id, topics) => ({ id, topics })),
  subscribeRealtimePatches: vi.fn(() => ({ close: vi.fn() })),
}));

const PREVIEW = "Add matching products to Buy Cart";
const COMMIT = "Add eligible products";
const ERROR = "We could not add matching products to Buy Cart. Try again, or open a product to add it individually.";
const SENTINEL = "PRIVATE_DATABASE_FAILURE_SENTINEL";
const counts = { addedLineCount: 1, mergedLineCount: 0, failedLineCount: 0, requestedLineCount: 1 };

function preview(): DiscoveryBulkCartPreview {
  return {
    totalMatches: 2,
    eligibleCount: 1,
    skippedCount: 1,
    overLimit: false,
    limit: 100,
    lines: [
      {
        catalog_item_id: "cat_pikachu",
        slug: "pikachu",
        title: "Pikachu",
        subtitle: null,
        image_url: null,
        image_srcset: null,
        image_loading_url: null,
        image_loading_alt: null,
        image_loading_srcset: null,
        product_id: "prd_pikachu",
        selected_options: [],
        product_summary: "Raw",
        quantity: 1,
      },
    ],
    skippedItems: [
      {
        catalog_item_id: "cat_raichu",
        slug: "raichu",
        title: "Raichu",
        reason: "product-options-required",
        message: "Choose options for Raichu.",
      },
    ],
  };
}

function searchData(url: string) {
  return {
    search: new URL(url).searchParams.get("q") ?? "pikachu",
    category: "",
    tag: "",
    language: "",
    marketActivity: "" as const,
    priceMin: "",
    priceMax: "",
    inStock: false,
    sort: "relevance",
    dynamicFilters: [],
    data: {
      items: [
        {
          catalog_item_id: "cat_pikachu",
          slug: "pikachu",
          title: "Pikachu",
          subtitle: null,
          description: "Bulk route fixture",
          language_code: "en",
          blueprint_id: "bp_card",
          blueprint_name: "Card",
          status: "active",
          category_names: ["Cards"],
          category_slugs: ["cards"],
          tags: [],
          image_urls: [],
          market_summary: { lowest_price_amount: "12.00", active_listing_count: 2, total_visible_quantity: 3 },
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      ],
      facets: [],
      category_counts: [],
      total: 2,
      count: 1,
      nextCursor: null,
      retrievalMode: "lexical" as const,
      lexicalCount: 1,
    },
    categories: [],
    canonicalUrl: url,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const routers: ReturnType<typeof createMemoryRouter>[] = [];
async function waitForRouterIdle(router: ReturnType<typeof createMemoryRouter>) {
  const isIdle = () =>
    router.state.initialized &&
    router.state.navigation.state === "idle" &&
    router.state.revalidation === "idle" &&
    [...router.state.fetchers.values()].every((fetcher) => fetcher.state === "idle");
  if (isIdle()) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = router.subscribe(() => {
      if (!isIdle()) return;
      unsubscribe();
      resolve();
    });
  });
}

async function settleRouter(router = routers[routers.length - 1]) {
  await act(async () => waitForRouterIdle(router));
}

async function setup(
  entry = "/search?q=pikachu#results",
  transform?: (response: Response) => Response,
  configure?: (router: ReturnType<typeof createMemoryRouter>) => void,
) {
  const requests: Request[] = [];
  const responses: Response[] = [];
  const load = vi.fn(({ request }: { request: Request }) => searchData(request.url));
  const runAction = vi.fn(async (args: Parameters<typeof action>[0]) => {
    requests.push(args.request.clone());
    const response = (await action(args)) as Response;
    responses.push(response.clone());
    return transform ? transform(response) : response;
  });
  const router = createMemoryRouter(
    [
      {
        Component: () => (
          <>
            <Outlet />
            <ScrollRestoration />
          </>
        ),
        children: [
          ...["/", "/search", "/categories/:categorySlug"].map((path) => ({
            path,
            loader: load,
            action: runAction,
            Component: SearchRoute,
          })),
          { path: "/ordinary", Component: () => <h1>Ordinary destination</h1> },
        ],
      },
    ],
    { initialEntries: [entry] },
  );
  routers.push(router);
  configure?.(router);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    await waitForRouterIdle(router);
    view = render(
      <ChaseRoot linkComponent={RouterLinkAdapter}>
        <RouterProvider router={router} />
      </ChaseRoot>,
    );
  });
  return { router, requests, responses, load, runAction, ...view };
}

async function openPreview() {
  fireEvent.click(await screen.findByRole("button", { name: PREVIEW }));
  await settleRouter();
  return screen.findByRole("dialog", { name: PREVIEW });
}

let y = 0;
let fetchSentinel: ReturnType<typeof vi.fn>;
const cartDelta = vi.fn<(event: Event) => void>();
beforeEach(() => {
  vi.resetAllMocks();
  previewQuery.mockResolvedValue(preview());
  addCartLines.mockResolvedValue(counts);
  addGuestCartLines.mockResolvedValue(counts);
  resolveActor.mockResolvedValue({ accountId: "acc_buyer" });
  fetchSentinel = vi.fn(async () => new Response("<!doctype html><title>document POST</title>"));
  vi.stubGlobal("fetch", fetchSentinel);
  y = 0;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
    y = typeof args[0] === "object" ? ((args[0] as ScrollToOptions).top ?? y) : Number(args[1]);
  });
  window.addEventListener("chase-sets:cart-count-changed", cartDelta);
});
afterEach(() => {
  cleanup();
  routers.splice(0).forEach((router) => router.dispose());
  window.removeEventListener("chase-sets:cart-count-changed", cartDelta);
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Search bulk route data transport", () => {
  it.each(["/", "/search", "/categories/cards"])(
    "submits preview through the current route data action: %s",
    async (path) => {
      const test = await setup(`${path}?q=pikachu`);
      await openPreview();
      expect(test.runAction).toHaveBeenCalledTimes(1);
      const request = test.requests[0];
      expect(new URL(request.url).pathname).toBe(path);
      expect(new URL(request.url).search).toBe("?q=pikachu");
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
      expect([...(await request.formData())]).toEqual([["intent", "preview-bulk-add"]]);
      expect(fetchSentinel).not.toHaveBeenCalled();
      expect(addCartLines).not.toHaveBeenCalled();
      expect(addGuestCartLines).not.toHaveBeenCalled();
    },
  );

  it.each(["eligible", "empty", "over-limit"])(
    "renders eligible skipped empty and over-limit previews: %s",
    async (kind) => {
      const value = preview();
      if (kind === "empty") {
        value.lines.splice(0);
        Object.assign(value, { eligibleCount: 0 });
      }
      if (kind === "over-limit") Object.assign(value, { overLimit: true, totalMatches: 101 });
      previewQuery.mockResolvedValue(value);
      await setup();
      const dialog = await openPreview();
      expect(within(dialog).getByText(String(value.totalMatches))).toBeTruthy();
      expect(within(dialog).getByText("Choose options for Raichu.")).toBeTruthy();
      expect((within(dialog).getByRole("button", { name: COMMIT }) as HTMLButtonElement).disabled).toBe(
        kind !== "eligible",
      );
      expect(addCartLines).not.toHaveBeenCalled();
      expect(addGuestCartLines).not.toHaveBeenCalled();
    },
  );

  it.each(["account", "guest"])("commits account and guest bulk additions once: %s", async (actor) => {
    if (actor === "guest") resolveActor.mockResolvedValue(null);
    const test = await setup();
    const dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole("button", { name: COMMIT }));
    await settleRouter(test.router);
    expect(await screen.findByRole("link", { name: "Review Buy Cart" })).toBeTruthy();
    expect(test.requests).toHaveLength(2);
    expect([...(await test.requests[1].formData())]).toEqual([["intent", "commit-bulk-add"]]);
    const expected = {
      lines: [
        {
          catalogItemId: "cat_pikachu",
          productId: "prd_pikachu",
          itemTitle: "Pikachu",
          itemSubtitle: null,
          itemImageUrl: null,
          itemImageSrcSet: null,
          itemImageLoadingUrl: null,
          itemImageLoadingAlt: null,
          itemImageLoadingSrcSet: null,
          selectedOptions: [],
          productSummary: "Raw",
          quantity: 1,
          fulfillmentMode: "optimize",
          lockedListingId: null,
        },
      ],
    };
    if (actor === "guest") {
      expect(addGuestCartLines).toHaveBeenCalledExactlyOnceWith(expect.any(String), expected);
      expect(test.responses[1].headers.get("set-cookie")).toContain(addGuestCartLines.mock.calls[0][0]);
      expect(addCartLines).not.toHaveBeenCalled();
    } else {
      expect(addCartLines).toHaveBeenCalledExactlyOnceWith(expected);
      expect(addGuestCartLines).not.toHaveBeenCalled();
    }
    expect(cartDelta).toHaveBeenCalledTimes(1);
    expect(cartDelta).toHaveBeenCalledWith(expect.objectContaining({ detail: { countDelta: 1 } }));
    expect(within(screen.getByRole("dialog")).getByText("1 added, 0 merged")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getByText("0 products could not be added.")).toBeTruthy();
  });

  it.each(["preview", "commit"])("recovers inline after a bulk action dependency rejects: %s", async (phase) => {
    const test = await setup();
    if (phase === "commit") await openPreview();
    const dependency = phase === "preview" ? previewQuery : addCartLines;
    dependency.mockRejectedValueOnce(new Error(SENTINEL));
    fireEvent.click(await screen.findByRole("button", { name: phase === "preview" ? PREVIEW : COMMIT }));
    await settleRouter(test.router);
    const active = phase === "commit" ? within(screen.getByRole("dialog")) : screen;
    const alert = await active.findByRole("alert");
    expect(alert.textContent).toContain(ERROR);
    expect(document.body.textContent).not.toContain(SENTINEL);
    expect(test.router.state.errors).toBeNull();
    expect(test.responses.at(-1)?.status).toBeGreaterThanOrEqual(400);
    expect(await test.responses.at(-1)?.json()).toEqual({ status: "bulk-error" });
    expect(cartDelta).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Review Buy Cart" })).toBeNull();
    const retry = active.getByRole("button", { name: phase === "preview" ? PREVIEW : COMMIT });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    await settleRouter(test.router);
    if (phase === "preview") await screen.findByRole("dialog");
    else await screen.findByRole("link", { name: "Review Buy Cart" });
    expect(screen.queryByText(ERROR)).toBeNull();
  });

  it("preserves thrown Response and redirect semantics", async () => {
    const response = new Response(null, { status: 302, headers: { Location: "/sign-in" } });
    previewQuery.mockRejectedValueOnce(response);
    await expect(
      action({
        request: new Request("http://localhost/search", {
          method: "POST",
          body: new URLSearchParams({ intent: "preview-bulk-add" }),
        }),
        params: {},
        context: {},
      }),
    ).rejects.toBe(response);
  });

  it("returns the real guest cookie from the direct action response", async () => {
    resolveActor.mockResolvedValue(null);
    const response = (await action({
      request: new Request("https://marketplace.test/search?q=pikachu", {
        method: "POST",
        body: new URLSearchParams({ intent: "commit-bulk-add" }),
      }),
      params: {},
      context: {},
    })) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(addGuestCartLines.mock.calls[0][0]);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(await response.json()).toEqual({ status: "bulk-added", preview: preview(), ...counts });
  });

  it.each([
    ["unknown", () => ({ status: "unknown", error: SENTINEL })],
    ["error envelope", () => ({ status: "bulk-error", error: SENTINEL })],
    ["missing preview", () => ({ status: "bulk-preview" })],
    ["negative count", () => ({ status: "bulk-preview", preview: { ...preview(), eligibleCount: -1 } })],
    ["fractional count", () => ({ status: "bulk-preview", preview: { ...preview(), skippedCount: 0.5 } })],
    ["invalid total", () => ({ status: "bulk-preview", preview: { ...preview(), totalMatches: "2" } })],
    ["invalid limit", () => ({ status: "bulk-preview", preview: { ...preview(), limit: 0 } })],
    ["invalid boolean", () => ({ status: "bulk-preview", preview: { ...preview(), overLimit: "false" } })],
    ["mixed lines", () => ({ status: "bulk-preview", preview: { ...preview(), lines: [...preview().lines, null] } })],
    [
      "invalid quantity",
      () => ({ status: "bulk-preview", preview: { ...preview(), lines: [{ ...preview().lines[0], quantity: 0 }] } }),
    ],
    [
      "invalid nullable field",
      () => ({ status: "bulk-preview", preview: { ...preview(), lines: [{ ...preview().lines[0], subtitle: {} }] } }),
    ],
    [
      "mixed options",
      () => ({
        status: "bulk-preview",
        preview: {
          ...preview(),
          lines: [
            {
              ...preview().lines[0],
              selected_options: [
                { dimensionId: "d", optionId: "o" },
                { dimensionId: 2, optionId: "o" },
              ],
            },
          ],
        },
      }),
    ],
    [
      "mixed skipped items",
      () => ({
        status: "bulk-preview",
        preview: {
          ...preview(),
          skippedItems: [...preview().skippedItems, { ...preview().skippedItems[0], reason: "unknown" }],
        },
      }),
    ],
    [
      "invalid skipped message",
      () => ({
        status: "bulk-preview",
        preview: { ...preview(), skippedItems: [{ ...preview().skippedItems[0], message: {} }] },
      }),
    ],
    ["unexpected commit", () => ({ status: "bulk-added", preview: preview(), ...counts })],
  ] as const)("rejects malformed and error-shaped data without publication: %s", async (_name, payload) => {
    await setup("/search?q=pikachu", () => Response.json(payload()));
    fireEvent.click(await screen.findByRole("button", { name: PREVIEW }));
    await settleRouter();
    expect((await screen.findByRole("alert")).textContent).toContain(ERROR);
    expect(document.body.textContent).not.toContain(SENTINEL);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cartDelta).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: PREVIEW }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(["addedLineCount", "mergedLineCount", "failedLineCount", "requestedLineCount"])(
    "retains the preview for invalid commit count %s",
    async (key) => {
      let malformed = false;
      await setup("/search?q=pikachu", (response) =>
        malformed ? Response.json({ status: "bulk-added", preview: preview(), ...counts, [key]: -1 }) : response,
      );
      await openPreview();
      malformed = true;
      fireEvent.click(screen.getByRole("button", { name: COMMIT }));
      await settleRouter();
      expect((await within(screen.getByRole("dialog")).findByRole("alert")).textContent).toContain(ERROR);
      expect(cartDelta).not.toHaveBeenCalled();
      expect(screen.queryByRole("link", { name: "Review Buy Cart" })).toBeNull();
    },
  );

  it("recovers after local submit rejection without replacing the router hooks", async () => {
    const test = await setup("/search?q=pikachu", undefined, (router) => {
      const fetch = router.fetch;
      vi.spyOn(router, "fetch").mockImplementationOnce(fetch).mockRejectedValueOnce(new Error(SENTINEL));
    });
    await openPreview();
    fireEvent.click(screen.getByRole("button", { name: COMMIT }));
    await settleRouter(test.router);
    expect((await within(screen.getByRole("dialog")).findByRole("alert")).textContent).toContain(ERROR);
    expect(test.router.state.errors).toBeNull();
    expect(cartDelta).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: COMMIT }));
    await settleRouter(test.router);
    await screen.findByRole("link", { name: "Review Buy Cart" });
    expect(cartDelta).toHaveBeenCalledTimes(1);
  });

  it("keeps the Result Set and nonzero scroll steady", async () => {
    const test = await setup();
    await screen.findByRole("button", { name: PREVIEW });
    const location = { ...test.router.state.location };
    y = 427;
    const pendingPreview = deferred<DiscoveryBulkCartPreview>();
    previewQuery.mockReturnValueOnce(pendingPreview.promise);
    fireEvent.click(screen.getByRole("button", { name: PREVIEW }));
    await waitFor(() => expect(test.runAction).toHaveBeenCalledTimes(1));
    expect(y).toBe(427);
    await act(async () => pendingPreview.resolve(preview()));
    await settleRouter(test.router);
    await screen.findByRole("dialog");
    expect(y).toBe(427);
    const pendingCommit = deferred<typeof counts>();
    addCartLines.mockReturnValueOnce(pendingCommit.promise);
    fireEvent.click(screen.getByRole("button", { name: COMMIT }));
    await waitFor(() => expect(addCartLines).toHaveBeenCalledTimes(1));
    expect(y).toBe(427);
    await act(async () => pendingCommit.reject(new Error(SENTINEL)));
    await settleRouter(test.router);
    await screen.findByText(ERROR);
    expect(y).toBe(427);
    fireEvent.click(screen.getByRole("button", { name: COMMIT }));
    await settleRouter(test.router);
    await screen.findByRole("link", { name: "Review Buy Cart" });
    expect(y).toBe(427);
    expect(test.router.state.location).toEqual(location);
    expect(test.load).toHaveBeenCalledTimes(1);
    expect(test.runAction).toHaveBeenCalledTimes(3);
  });

  it("resets scroll on an ordinary new navigation", async () => {
    const test = await setup();
    await screen.findByRole("button", { name: PREVIEW });
    y = 427;
    vi.mocked(window.scrollTo).mockClear();
    await act(async () => test.router.navigate("/ordinary"));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(y).toBe(0);
  });

  it.each(["preview success", "preview failure", "commit success", "commit failure"])(
    "admits one intent and ignores old results after reset: %s",
    async (scenario) => {
      const committing = scenario.startsWith("commit");
      const old = deferred<DiscoveryBulkCartPreview | typeof counts>();
      const test = await setup();
      if (committing) await openPreview();
      (committing ? addCartLines : previewQuery).mockReturnValueOnce(old.promise);
      const button = await screen.findByRole("button", { name: committing ? COMMIT : PREVIEW });
      act(() => {
        button.click();
        button.click();
      });
      const oldCount = committing ? 2 : 1;
      await waitFor(() => expect(test.runAction).toHaveBeenCalledTimes(oldCount));
      if (committing) await waitFor(() => expect(addCartLines).toHaveBeenCalledTimes(1));
      const oldSignal = test.runAction.mock.calls[oldCount - 1][0].request.signal;
      await act(async () => test.router.navigate("/search?q=raichu"));
      expect(oldSignal.aborted).toBe(true);
      const current = deferred<DiscoveryBulkCartPreview>();
      previewQuery.mockReturnValueOnce(current.promise);
      fireEvent.click(screen.getByRole("button", { name: PREVIEW }));
      await waitFor(() => expect(test.runAction).toHaveBeenCalledTimes(oldCount + 1));
      await act(async () => {
        if (scenario.endsWith("success")) old.resolve(committing ? counts : preview());
        else old.reject(new Error(SENTINEL));
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(ERROR)).toBeNull();
      expect((screen.getByRole("button", { name: PREVIEW }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => current.resolve({ ...preview(), totalMatches: 9 }));
      await settleRouter(test.router);
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("9")).toBeTruthy();
      expect(cartDelta).not.toHaveBeenCalled();
    },
  );

  it("recovers the existing bulk controls across every phase", async () => {
    const test = await setup();
    const pending = deferred<DiscoveryBulkCartPreview>();
    previewQuery.mockReturnValueOnce(pending.promise);
    fireEvent.click(await screen.findByRole("button", { name: PREVIEW }));
    expect((screen.getByRole("button", { name: PREVIEW }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve(preview()));
    await settleRouter(test.router);
    const dialog = await screen.findByRole("dialog");
    const commit = deferred<typeof counts>();
    addCartLines.mockReturnValueOnce(commit.promise);
    const button = within(dialog).getByRole("button", { name: COMMIT });
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(addCartLines).toHaveBeenCalledTimes(1));
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => commit.resolve(counts));
    await settleRouter(test.router);
    await screen.findByRole("link", { name: "Review Buy Cart" });
    expect(cartDelta).toHaveBeenCalledTimes(1);
    test.unmount();
    test.router.dispose();
    await setup();
    await screen.findByRole("button", { name: PREVIEW });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cartDelta).toHaveBeenCalledTimes(1);
    expect(previewQuery).toHaveBeenCalledTimes(2);
    expect(addCartLines).toHaveBeenCalledTimes(1);
  });

  it("shows preview failure on the page after resetting an open sheet", async () => {
    const test = await setup();
    await openPreview();
    await act(async () => test.router.navigate("/search?q=raichu"));
    expect(screen.queryByRole("dialog")).toBeNull();
    previewQuery.mockRejectedValueOnce(new Error(SENTINEL));
    fireEvent.click(screen.getByRole("button", { name: PREVIEW }));
    await settleRouter(test.router);
    expect((await screen.findByRole("alert")).textContent).toContain(ERROR);
    await act(async () => test.router.navigate("/search?q=eevee"));
    expect(screen.queryByText(ERROR)).toBeNull();
    await openPreview();
    expect(cartDelta).not.toHaveBeenCalled();
  });

  it("renders on the server without submission", () => {
    const router = createMemoryRouter(
      [
        {
          id: "search",
          path: "/search",
          loader: () => {
            throw new Error("Unexpected loader");
          },
          action,
          Component: SearchRoute,
        },
      ],
      {
        initialEntries: ["/search?q=pikachu"],
        hydrationData: { loaderData: { search: searchData("http://localhost/search?q=pikachu") } },
      },
    );
    routers.push(router);
    expect(renderToString(<RouterProvider router={router} />)).toContain(PREVIEW);
    expect(fetchSentinel).not.toHaveBeenCalled();
    expect(previewQuery).not.toHaveBeenCalled();
  });
});
