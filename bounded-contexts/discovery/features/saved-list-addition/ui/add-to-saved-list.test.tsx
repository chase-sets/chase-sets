// @vitest-environment jsdom

import { t } from "@chase-sets/localization";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createContext, useContext } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FRESH_WRITE_MAX_AGE_MS } from "@chase-sets/http/responses";
import type { SavedListPickerPreparation } from "./contracts";
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

const controlProps = {
  productKey: preparation.product.productId,
  productLabel: preparation.productLabel,
  prepareFields: { slug: "pikachu" },
};
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

async function setup(
  result: () => unknown = () => ({ status: "ready", preparation }),
  initialPreparation: SavedListPickerPreparation | null = null,
  entry = "/search?q=pikachu",
  props = controlProps,
) {
  const Product = createContext(props);
  const requests: Request[] = [];
  const action = vi.fn(({ request }: { request: Request }) => {
    requests.push(request.clone());
    return result();
  });
  const loader = vi.fn(() => null);
  const router = createMemoryRouter(
    [
      {
        path: "*",
        loader,
        action,
        Component: () => <AddToSavedListControl {...useContext(Product)} initialPreparation={initialPreparation} />,
      },
    ],
    { initialEntries: [entry] },
  );
  routers.push(router);
  const tree = (props: typeof controlProps) => (
    <Product.Provider value={props}>
      <RouterProvider router={router} />
    </Product.Provider>
  );
  await act(async () => waitForRouterIdle(router));
  const view = render(tree(props));
  return {
    router,
    action,
    loader,
    requests,
    rerender: (next: typeof controlProps) => view.rerender(tree(next)),
    unmount: view.unmount,
  };
}

function prepare(label = controlProps.productLabel) {
  fireEvent.click(screen.getByRole("button", { name: `Add ${label} to a Saved List` }));
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  routers.splice(0).forEach((router) => router.dispose());
});

describe("Add to Saved List control", () => {
  it("renders the localized recent-List picker from prepared Collections data", async () => {
    await setup(undefined, preparation);

    expect(screen.getByRole("heading", { name: "Add to List" })).not.toBeNull();
    expect(screen.getByText("Pikachu · Near Mint")).not.toBeNull();
    expect(screen.getByText("Favorites")).not.toBeNull();
    expect(screen.getByText("2 lines · 3 tracked")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add Product" }).hasAttribute("disabled")).toBe(false);
  });

  it.each(["/search?q=pikachu", "/items/pikachu?dimension.condition=near-mint"])(
    "prepares and commits through the current route without revalidating its loader: %s",
    async (entry) => {
      const result = vi.fn((): unknown => ({ status: "ready", preparation }));
      const test = await setup(result, null, entry);
      prepare();
      await act(async () => waitForRouterIdle(test.router));
      expect(test.action).toHaveBeenCalledTimes(1);
      expect([...(await test.requests[0].formData()).entries()]).toEqual([
        ["intent", "prepare-saved-list"],
        ["slug", "pikachu"],
      ]);
      expect(test.requests[0].method).toBe("POST");
      expect(new URL(test.requests[0].url).pathname + new URL(test.requests[0].url).search).toBe(entry);
      expect(screen.getByRole("radio", { name: /Favorites/ })).not.toBeNull();
      expect(screen.getByRole("radio", { name: /Create a new Saved List/ })).not.toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();

      fireEvent.click(screen.getByRole("radio", { name: /Create a new Saved List/ }));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "New Favorites" } });
      result.mockReturnValue({
        status: "saved",
        result: { listId: "svl_new", title: "New Favorites", lineStatus: "added" },
        trackedQuantity: 1,
        postWriteToken: "pwt_test0000000001",
      });
      fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
      await act(async () => waitForRouterIdle(test.router));
      expect(test.action).toHaveBeenCalledTimes(2);
      expect(Object.fromEntries(await test.requests[1].formData())).toEqual({
        intent: "commit-saved-list",
        preparation: JSON.stringify(preparation),
        trackedQuantity: "1",
        destinationKind: "new",
        newListTitle: "New Favorites",
      });
      expect(new URL(test.requests[1].url).pathname + new URL(test.requests[1].url).search).toBe(entry);
      expect(screen.getByRole("status").textContent).toContain("New Favorites");
      expect(screen.getByRole("link", { name: "View in My Collection" }).getAttribute("href")).toContain(
        "section=lists",
      );
      expect(new URL(window.location.href).searchParams.has("postWriteToken")).toBe(false);
      expect(test.router.state.location.search).toBe(new URL(entry, "http://localhost").search);
      expect(test.loader).toHaveBeenCalledTimes(1);
      expect(test.router.state.errors).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      result.mockReturnValue({ status: "ready", preparation });
      prepare();
      await act(async () => waitForRouterIdle(test.router));
      expect(test.action).toHaveBeenCalledTimes(3);
      expect(new URL(test.requests[2].url).pathname).toBe(new URL(entry, "http://localhost").pathname);
      expect(new URL(test.requests[2].url).searchParams.get("postWriteToken")).toBe("pwt_test0000000001");
      expect(screen.getByRole("radio", { name: /Favorites/ })).not.toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(test.loader).toHaveBeenCalledTimes(1);
    },
  );

  // AC9 matrix. Each action result is the exact Response shape the same-named
  // row in support/request-support/saved-list-addition.test.ts produces.
  describe("AC9 router matrix", () => {
    const tokenA = "pwt_test0000000001";
    const newListEntry = {
      listId: "svl_new",
      title: "New Favorites",
      lineCount: 1,
      trackedUnitCount: 1,
      version: 2,
      changedAt: "2026-10-17T00:00:00.000Z",
    };
    const ready = (recentLists = preparation.recentLists) => ({
      status: "ready",
      preparation: { ...preparation, recentLists },
    });
    const saved = (postWriteToken: string | undefined = tokenA, title = "New Favorites") => ({
      status: "saved",
      result: { listId: "svl_new", title, lineStatus: "added" },
      trackedQuantity: 1,
      ...(postWriteToken ? { postWriteToken } : {}),
    });
    const retryable = () =>
      Response.json({ error: t("collections.features.savedLists.ui.addToList.error.description") }, { status: 503 });
    const queue =
      (...results: unknown[]) =>
      () =>
        results.shift();
    type Harness = Awaited<ReturnType<typeof setup>>;

    async function settle(test: Harness) {
      await act(async () => waitForRouterIdle(test.router));
    }

    async function commitNewList(test: Harness, label = controlProps.productLabel) {
      prepare(label);
      await settle(test);
      fireEvent.click(screen.getByRole("radio", { name: /Create a new Saved List/ }));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "New Favorites" } });
      fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
      await settle(test);
      expect(screen.getByRole("status").textContent).toContain("New Favorites");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    }

    async function reopen(test: Harness, label = controlProps.productLabel) {
      prepare(label);
      await settle(test);
    }

    function actionToken(test: Harness, index = test.requests.length - 1) {
      return new URL(test.requests[index]!.url).searchParams.get("postWriteToken");
    }

    function expectSteadyRoute(test: Harness) {
      expect(test.router.state.errors).toBeNull();
      expect(test.loader).toHaveBeenCalledTimes(1);
      expect(test.router.state.historyAction).toBe("POP");
      expect(`${test.router.state.location.search}${test.router.state.location.hash}`).not.toContain("postWriteToken");
      expect(window.location.href).not.toContain("postWriteToken");
    }

    function expectRetryableError() {
      expect(
        within(screen.getByRole("alert")).getByText(
          t("collections.features.savedLists.ui.addToList.error.description"),
          {
            exact: true,
          },
        ),
      ).not.toBeNull();
      expect(document.body.textContent).not.toMatch(/projection|receipt|timeout|postWriteToken/i);
    }

    it("valid receipt: reopen carries the token and renders the receipted new List", async () => {
      const test = await setup(queue(ready(), saved(), ready([newListEntry, ...preparation.recentLists])));
      await commitNewList(test);
      await reopen(test);
      expect(test.action).toHaveBeenCalledTimes(3);
      expect(actionToken(test)).toBe(tokenA);
      expect(screen.getByRole("radio", { name: /^New Favorites/ })).not.toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expectSteadyRoute(test);
    });

    it("expired receipt: the token is still sent and the ordinary read renders without a freshness claim", async () => {
      const test = await setup(queue(ready(), saved(), ready()));
      await commitNewList(test);
      await reopen(test);
      expect(test.action).toHaveBeenCalledTimes(3);
      expect(actionToken(test)).toBe(tokenA);
      expect(screen.getByRole("radio", { name: /^Favorites/ })).not.toBeNull();
      expect(screen.queryByRole("radio", { name: /^New Favorites/ })).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expectSteadyRoute(test);
    });

    it.each([
      ["valid token", DEFAULT_FRESH_WRITE_MAX_AGE_MS - 1, tokenA],
      ["expired token", DEFAULT_FRESH_WRITE_MAX_AGE_MS, null],
    ])("%s: the action URL token follows the fresh-write age", async (_row, ageMs, expectedToken) => {
      const now = Date.now();
      vi.setSystemTime(now);
      const test = await setup(queue(ready(), saved(), ready()));
      await commitNewList(test);
      vi.setSystemTime(now + ageMs);
      await reopen(test);
      expect(test.action).toHaveBeenCalledTimes(3);
      expect(actionToken(test)).toBe(expectedToken);
      expect(screen.getByRole("radio", { name: /^Favorites/ })).not.toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expectSteadyRoute(test);
    });

    it("malformed token: forwarded as returned and the ordinary read renders without an error", async () => {
      const test = await setup(queue(ready(), saved("not a token!"), ready()));
      await commitNewList(test);
      await reopen(test);
      expect(test.action).toHaveBeenCalledTimes(3);
      expect(actionToken(test)).toBe("not a token!");
      expect(screen.getByRole("radio", { name: /^Favorites/ })).not.toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expectSteadyRoute(test);
    });

    it.each(["unresolvable token", "timeout"])(
      "%s: localized retryable error, then a retry with the same token renders the List",
      async () => {
        const test = await setup(queue(ready(), saved(), retryable(), ready([newListEntry])));
        await commitNewList(test);
        await reopen(test);
        expect(test.action).toHaveBeenCalledTimes(3);
        expect(actionToken(test)).toBe(tokenA);
        expectRetryableError();
        expectSteadyRoute(test);
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await reopen(test);
        expect(test.action).toHaveBeenCalledTimes(4);
        expect(actionToken(test)).toBe(tokenA);
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByRole("radio", { name: /^New Favorites/ })).not.toBeNull();
        expectSteadyRoute(test);
      },
    );

    it("busy: prepare and commit disable their actions until the deferred result settles", async () => {
      let resolveCommit!: (value: unknown) => void;
      const test = await setup(queue(ready(), new Promise((yes) => (resolveCommit = yes))));
      await reopen(test);
      fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
      await waitFor(() => expect(test.action).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("button", { name: "Add Product" }).hasAttribute("disabled")).toBe(true);
      expect(actionToken(test)).toBeNull();
      await act(async () => {
        resolveCommit(saved());
        await waitForRouterIdle(test.router);
      });
      expect(screen.getByRole("status").textContent).toContain("New Favorites");
      expectSteadyRoute(test);
    });

    it("empty: no recent Lists offers only Create new", async () => {
      const test = await setup(queue(ready([])));
      await reopen(test);
      expect(test.action).toHaveBeenCalledTimes(1);
      expect(actionToken(test)).toBeNull();
      expect(screen.getByText(t("collections.features.savedLists.ui.addToList.no.lists"))).not.toBeNull();
      expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
        expect.stringContaining("Create a new Saved List"),
      ]);
      expectSteadyRoute(test);
    });

    it("error: a shaped action error renders in the picker", async () => {
      const message = t("collections.features.savedLists.api.route.request.invalid");
      const test = await setup(queue(Response.json({ error: message }, { status: 400 })));
      await reopen(test);
      expect(test.action).toHaveBeenCalledTimes(1);
      expect(actionToken(test)).toBeNull();
      expect(within(screen.getByRole("alert")).getByText(message, { exact: true })).not.toBeNull();
      expectSteadyRoute(test);
    });

    it("saved: success names the List and links to it in My Collection", async () => {
      const test = await setup(queue(ready(), saved()));
      prepare();
      await settle(test);
      fireEvent.click(screen.getByRole("radio", { name: /Create a new Saved List/ }));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "New Favorites" } });
      fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
      await settle(test);
      expect(test.action).toHaveBeenCalledTimes(2);
      expect(actionToken(test)).toBeNull();
      expect(screen.getByRole("status").textContent).toContain("New Favorites");
      expect(screen.getByRole("link", { name: "View in My Collection" }).getAttribute("href")).toBe(
        "/account/collection?section=lists&list=svl_new",
      );
      expectSteadyRoute(test);
    });

    it("reopen: keeps the current pathname, search and prepare fields and adds only the token", async () => {
      const entry = "/items/pikachu?dimension.condition=near-mint";
      const test = await setup(queue(ready(), saved(), ready()), null, entry);
      await commitNewList(test);
      await reopen(test);
      expect(test.action).toHaveBeenCalledTimes(3);
      const url = new URL(test.requests[2]!.url);
      expect(url.searchParams.get("postWriteToken")).toBe(tokenA);
      url.searchParams.delete("postWriteToken");
      expect(`${url.pathname}${url.search}`).toBe(entry);
      expect([...(await test.requests[2]!.formData()).entries()]).toEqual([
        ["intent", "prepare-saved-list"],
        ["slug", "pikachu"],
      ]);
      expectSteadyRoute(test);
    });

    it("repeat reopen: every reopen within the age carries the same token without revalidating", async () => {
      const test = await setup(queue(ready(), saved(), ready(), ready()));
      await commitNewList(test);
      await reopen(test);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await reopen(test);
      expect(test.action).toHaveBeenCalledTimes(4);
      expect([actionToken(test, 2), actionToken(test, 3)]).toEqual([tokenA, tokenA]);
      expectSteadyRoute(test);
    });

    it("Product change: the token is cleared and the next prepare uses the new Product's fields", async () => {
      const test = await setup(queue(ready(), saved(), ready()));
      await commitNewList(test);
      const next: typeof controlProps = {
        productKey: "cat_card::condition:lightly-played",
        productLabel: "Pikachu · Lightly Played",
        prepareFields: { slug: "pikachu-lightly-played" },
      };
      test.rerender(next);
      await reopen(test, next.productLabel);
      expect(test.action).toHaveBeenCalledTimes(3);
      expect(actionToken(test)).toBeNull();
      expect(Object.fromEntries(await test.requests[2]!.formData())).toEqual({
        intent: "prepare-saved-list",
        slug: "pikachu-lightly-played",
      });
      expectSteadyRoute(test);
    });

    it("unmount: a result that settles after unmount changes nothing and raises no route error", async () => {
      let resolvePrepare!: (value: unknown) => void;
      const test = await setup(queue(new Promise((yes) => (resolvePrepare = yes))));
      prepare();
      await waitFor(() => expect(test.action).toHaveBeenCalledTimes(1));
      test.unmount();
      await act(async () => {
        resolvePrepare(ready());
        await waitForRouterIdle(test.router);
      });
      expect(actionToken(test)).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expectSteadyRoute(test);
    });

    it("actor A/B: a separate control instance never carries another instance's token", async () => {
      const actorB: typeof controlProps = {
        productKey: "cat_charizard::condition:near-mint",
        productLabel: "Charizard · Near Mint",
        prepareFields: { slug: "charizard" },
      };
      const testA = await setup(queue(ready(), saved(), ready()));
      const testB = await setup(queue(ready()), null, "/search?q=pikachu", actorB);
      await commitNewList(testA);
      await reopen(testB, actorB.productLabel);
      expect(testB.action).toHaveBeenCalledTimes(1);
      expect(actionToken(testB)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await reopen(testA);
      expect(testA.action).toHaveBeenCalledTimes(3);
      expect(actionToken(testA)).toBe(tokenA);
      expectSteadyRoute(testA);
      expectSteadyRoute(testB);
    });

    it("archived: the picker renders exactly the active Lists the action returns", async () => {
      const test = await setup(queue(ready([newListEntry])));
      await reopen(test);
      expect(test.action).toHaveBeenCalledTimes(1);
      expect(actionToken(test)).toBeNull();
      expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
        expect.stringContaining("New Favorites"),
        expect.stringContaining("Create a new Saved List"),
      ]);
      expectSteadyRoute(test);
    });

    it("token-bearing anonymous prepare: the token rides only the action URL and no picker opens", async () => {
      const href = `/register?returnTo=${encodeURIComponent("/search?q=pikachu&claimSavedListIntent=sli_test")}`;
      const test = await setup(queue(ready(), saved(), { status: "registration-required", href }));
      await commitNewList(test);
      await reopen(test);
      expect(test.action).toHaveBeenCalledTimes(3);
      expect(actionToken(test)).toBe(tokenA);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expectSteadyRoute(test);
    });

    it("only the newest matching commit replaces the token; duplicate and stale results are ignored", async () => {
      let resolveStale!: (value: unknown) => void;
      const test = await setup(
        queue(
          ready(),
          saved(tokenA),
          ready(),
          saved("pwt_test0000000002", "Favorites"),
          ready(),
          ready(),
          new Promise((yes) => (resolveStale = yes)),
          ready(),
        ),
      );
      await commitNewList(test);
      await reopen(test);
      fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
      await settle(test);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      test.rerender({ ...controlProps });
      await reopen(test);
      expect(actionToken(test, 4)).toBe("pwt_test0000000002");

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await reopen(test);
      fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
      await waitFor(() => expect(test.action).toHaveBeenCalledTimes(7));
      const next: typeof controlProps = { ...controlProps, productKey: "cat_card::condition:lightly-played" };
      test.rerender(next);
      await act(async () => {
        resolveStale(saved("pwt_test0000000003"));
        await waitForRouterIdle(test.router);
      });
      expect(screen.queryByRole("status")).toBeNull();
      await reopen(test);
      expect(test.action).toHaveBeenCalledTimes(8);
      expect(actionToken(test)).toBeNull();
      expectSteadyRoute(test);
    });
  });

  it("ignores a preparation response after the visible Product changes", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((yes) => {
      resolve = yes;
    });
    const test = await setup(() => pending);
    prepare();
    await waitFor(() => expect(test.action).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("button", { name: "Add Pikachu · Near Mint to a Saved List" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(Object.fromEntries(await test.requests[0].formData())).toEqual({
      intent: "prepare-saved-list",
      slug: "pikachu",
    });
    test.rerender({
      productKey: "cat_card::condition:lightly-played",
      productLabel: "Pikachu · Lightly Played",
      prepareFields: { slug: "pikachu-lightly-played" },
    });
    await act(async () => {
      resolve({ status: "ready", preparation });
      await waitForRouterIdle(test.router);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add Pikachu · Lightly Played to a Saved List" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(test.loader).toHaveBeenCalledTimes(1);
  });

  it("shows a deferred preparation response while the visible Product is unchanged", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((yes) => {
      resolve = yes;
    });
    const test = await setup(() => pending);
    prepare();
    await waitFor(() => expect(test.action).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolve({ status: "ready", preparation });
      await waitForRouterIdle(test.router);
    });
    expect(screen.getByRole("radio", { name: /Favorites/ })).not.toBeNull();
  });

  it("ignores a preparation response even if the visible Product changes back", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((yes) => {
      resolve = yes;
    });
    const test = await setup(() => pending);
    prepare();
    await waitFor(() => expect(test.action).toHaveBeenCalledTimes(1));
    test.rerender({ ...controlProps, productKey: "cat_card::condition:lightly-played" });
    test.rerender(controlProps);
    await act(async () => {
      resolve({ status: "ready", preparation });
      await waitForRouterIdle(test.router);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores a commit response after the visible Product changes", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((yes) => {
      resolve = yes;
    });
    const test = await setup(() => pending, preparation);
    fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
    await waitFor(() => expect(test.action).toHaveBeenCalledTimes(1));
    expect((await test.requests[0].formData()).get("intent")).toBe("commit-saved-list");
    expect(screen.getByRole("button", { name: "Add Product" }).hasAttribute("disabled")).toBe(true);
    test.rerender({ ...controlProps, productKey: "cat_card::condition:lightly-played" });
    await act(async () => {
      resolve({
        status: "saved",
        result: { listId: "svl_favorites", title: "Favorites", lineStatus: "added" },
        trackedQuantity: 1,
      });
      await waitForRouterIdle(test.router);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(test.loader).toHaveBeenCalledTimes(1);
  });

  describe.each(["prepare", "commit"])("%s error results", (intent) => {
    const nonContractResults: ReadonlyArray<readonly [string, () => unknown]> = [
      [
        "HTML",
        () =>
          new Response("<!DOCTYPE html><title>Unexpected token SyntaxError</title>", {
            headers: { "content-type": "text/html" },
          }),
      ],
      ["empty 500", () => Response.json({}, { status: 500 })],
      ["empty error", () => Response.json({ error: "" }, { status: 400 })],
      ["blank error", () => ({ error: "   " })],
      ["non-string error", () => ({ error: { message: "SyntaxError" } })],
      ["unknown status", () => ({ status: "Unexpected token" })],
      ["null", () => null],
    ];
    it.each(nonContractResults)("localizes non-contract action data: %s", async (_name, result) => {
      const test = await setup(result, intent === "commit" ? preparation : null);
      if (intent === "prepare") prepare();
      else fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
      await act(async () => waitForRouterIdle(test.router));
      expect(test.action).toHaveBeenCalledTimes(1);
      const banner = screen.getByRole("alert");
      expect(
        within(banner).getByText(t("collections.features.savedLists.ui.addToList.error.description"), { exact: true }),
      ).not.toBeNull();
      expect(document.body.textContent).not.toMatch(/Unexpected token|SyntaxError/);
      expect(test.router.state.errors).toBeNull();
      expect(test.loader).toHaveBeenCalledTimes(1);
    });

    it("renders a shaped action error", async () => {
      const message = t("collections.features.savedLists.api.route.request.invalid");
      const test = await setup(
        () => Response.json({ error: message }, { status: 400 }),
        intent === "commit" ? preparation : null,
      );
      if (intent === "prepare") prepare();
      else fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
      await act(async () => waitForRouterIdle(test.router));
      expect(test.action).toHaveBeenCalledTimes(1);
      expect(within(screen.getByRole("alert")).getByText(message, { exact: true })).not.toBeNull();
      expect(test.router.state.errors).toBeNull();
    });
  });
});
