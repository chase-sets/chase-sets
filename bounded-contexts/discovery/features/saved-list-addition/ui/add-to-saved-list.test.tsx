// @vitest-environment jsdom

import { t } from "@chase-sets/localization";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createContext, useContext } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
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
) {
  const Product = createContext(controlProps);
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
  const view = render(tree(controlProps));
  return { router, action, loader, requests, rerender: (props: typeof controlProps) => view.rerender(tree(props)) };
}

function prepare() {
  fireEvent.click(screen.getByRole("button", { name: "Add Pikachu · Near Mint to a Saved List" }));
}

afterEach(() => {
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
      const replaceState = vi.spyOn(window.history, "replaceState");
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
      expect(replaceState).toHaveBeenCalled();
      const retainedUrl = String(replaceState.mock.calls.at(-1)?.[2] ?? "");
      expect(new URL(retainedUrl, "http://localhost").searchParams.get("postWriteToken")).toBe("pwt_test0000000001");
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
