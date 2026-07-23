// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../features/source-observations/ui/primary-workbench-read-model";
import {
  controlPlaneOverview,
  profileReview,
  sourceObservationScope,
} from "../../features/source-observations/ui/primary-workbench-test-fixtures";
import CatalogProviderDetailRoute from "./catalog-provider-detail";

afterEach(() => {
  cleanup();
});

function readModelAt(generatedAt: string, now: string) {
  const profile = profileReview({ providerKey: "tcgdex", active: true, lifecycle: "active" });
  return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl: "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex",
    scopes: { items: [sourceObservationScope({ provider_key: "tcgdex" })], total: 1, count: 1 },
    profileReviews: { items: [profile], total: 1, count: 1 },
    controlPlaneOverview: controlPlaneOverview({ generatedAt }),
    canManageCatalog: true,
    now,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// This drives the real route composition (react-router's data router, the
// actual useRevalidator wiring in CatalogProviderDetailRoute, and the actual
// loader boundary) rather than injecting onRevalidate/revalidating props by
// hand, so it proves the wiring itself — not just that the presentational
// page reacts correctly to whatever props it is handed.
describe("CatalogProviderDetailRoute revalidation", () => {
  it("reruns the loader on Refresh, exposes an accessible busy state during the transition, and clears the affordance once fresh", async () => {
    const laggedReadModel = readModelAt("2000-01-01T00:00:00.000Z", "2000-01-01T01:00:00.000Z");
    const freshReadModel = readModelAt("2026-06-09T01:05:00.000Z", "2026-06-09T01:05:05.000Z");
    expect(laggedReadModel.healthTriage.freshness).toBe("unavailable");
    expect(freshReadModel.healthTriage.freshness).toBe("fresh");

    let loaderCallCount = 0;
    const revalidateLoaderCall = deferred<void>();
    const routeId = "provider-detail";

    // `hydrationData` seeds the router with the lagged read model already
    // resolved, so the initial render is synchronous — no pending loader
    // promise for `RouterProvider` to race against Testing Library's default
    // query wait. The route's real `loader` only runs when `useRevalidator`
    // actually triggers it (the Refresh click below), which is the transition
    // this test exists to prove.
    const router = createMemoryRouter(
      [
        {
          id: routeId,
          path: "/catalog/providers/:providerKey",
          Component: CatalogProviderDetailRoute,
          loader: async () => {
            loaderCallCount += 1;
            await revalidateLoaderCall.promise;
            return { readModel: freshReadModel, commandFeedback: null, providerRefreshSchedules: [] };
          },
        },
      ],
      {
        initialEntries: ["/catalog/providers/tcgdex"],
        hydrationData: {
          loaderData: {
            [routeId]: { readModel: laggedReadModel, commandFeedback: null, providerRefreshSchedules: [] },
          },
        },
      },
    );

    render(<RouterProvider router={router} />);

    const revalidateButton = await screen.findByRole("button", { name: "Refresh" });
    expect(loaderCallCount).toBe(0);
    expect(revalidateButton.getAttribute("aria-busy")).not.toBe("true");
    expect(revalidateButton.hasAttribute("disabled")).toBe(false);

    revalidateButton.click();

    // The revalidation loader invocation is in flight (held open by
    // revalidateLoaderCall) — this is the real router transition's busy
    // window, not a manually constructed `revalidating` prop.
    await waitFor(() => {
      expect(loaderCallCount).toBe(1);
      expect(revalidateButton.getAttribute("aria-busy")).toBe("true");
      expect(revalidateButton.hasAttribute("disabled")).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBe(revalidateButton);

    revalidateLoaderCall.resolve();

    await waitFor(() => {
      expect(
        document
          .querySelector("[data-catalog-provider-detail-freshness]")
          ?.getAttribute("data-catalog-provider-detail-freshness"),
      ).toBe("fresh");
      expect(document.querySelector('[data-catalog-provider-detail-revalidate="true"]')).toBeNull();
    });
  });
});
