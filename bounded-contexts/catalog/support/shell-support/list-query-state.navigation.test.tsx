// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouterProvider, createMemoryRouter, useLoaderData } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ChaseRoot, LinkButton } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { readCatalogListQuery, useCatalogListQueryControls, type CatalogListQuery } from "./list-query-state";

// Regression for issue #4955: with the DS LinkAdapter registered, a row's View link
// performs a client-side navigation instead of a full document load. The list page
// therefore stays alive while the detail loader runs, and a still-pending debounced
// search commit used to fire mid-navigation, interrupting the detail navigation and
// yanking the browser back to `/catalog/fields?search=...`.

const DEBOUNCE_MS = 40;

function FieldListHarness() {
  const query = useLoaderData() as CatalogListQuery;
  const controls = useCatalogListQueryControls(query, DEBOUNCE_MS);

  return (
    <div>
      <input aria-label="Search" value={controls.search} onChange={(event) => controls.setSearch(event.target.value)} />
      <LinkButton href="/catalog/fields/fld_1">View</LinkButton>
    </div>
  );
}

function createDeferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<null>((resolveFn) => {
    resolve = () => resolveFn(null);
  });
  return { promise, resolve };
}

function renderCatalogFieldsRouter(detailLoader: { promise: Promise<null> }) {
  const router = createMemoryRouter(
    [
      {
        path: "/catalog/fields",
        loader: ({ request }) => readCatalogListQuery(request),
        Component: FieldListHarness,
      },
      {
        path: "/catalog/fields/:fieldId",
        loader: () => detailLoader.promise,
        Component: () => <h1>Field Detail</h1>,
      },
    ],
    { initialEntries: ["/catalog/fields"] },
  );

  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );

  return router;
}

describe("catalog list detail navigation with a pending debounced search", () => {
  afterEach(cleanup);

  it("renders the View affordance as a real anchor through the registered LinkAdapter", async () => {
    const detailLoader = createDeferred();
    renderCatalogFieldsRouter(detailLoader);

    const viewLink = await screen.findByRole("link", { name: "View" });
    expect(viewLink.tagName).toBe("A");
    expect(viewLink.getAttribute("href")).toBe("/catalog/fields/fld_1");
  });

  it("does not let the debounced search commit clobber an in-flight detail navigation", async () => {
    const detailLoader = createDeferred();
    const router = renderCatalogFieldsRouter(detailLoader);

    const viewLink = await screen.findByRole("link", { name: "View" });

    // Type into search (arms the debounce), then click View before the debounce fires
    // — exactly the catalog modeling e2e sequence.
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "Card Name" } });
    fireEvent.click(viewLink);

    await waitFor(() => expect(router.state.navigation.state).toBe("loading"));

    // Let the debounce elapse while the detail loader is still in flight.
    await new Promise((resolveFn) => setTimeout(resolveFn, DEBOUNCE_MS * 3));
    detailLoader.resolve();

    await waitFor(() => expect(router.state.location.pathname).toBe("/catalog/fields/fld_1"));
    await screen.findByRole("heading", { name: "Field Detail" });
  });

  it("still commits the debounced search when the operator stays on the list", async () => {
    const detailLoader = createDeferred();
    const router = renderCatalogFieldsRouter(detailLoader);

    await screen.findByRole("link", { name: "View" });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "Card Name" } });

    await waitFor(() => expect(router.state.location.search).toBe("?search=Card+Name"));
    expect(router.state.location.pathname).toBe("/catalog/fields");
  });
});
