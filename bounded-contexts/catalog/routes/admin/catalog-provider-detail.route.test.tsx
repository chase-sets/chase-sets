// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCatalogPrimaryWorkbenchReadModelForSurface,
} from "../../features/source-observations/ui/primary-workbench-read-model";
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
  // The real data router's hydration + revalidation cycle spans several
  // microtask/render turns; give it headroom beyond the default 5s budget.
  it("reruns the loader on Refresh, exposes an accessible busy state during the transition, and clears the affordance once fresh", async () => {
    const laggedReadModel = readModelAt("2000-01-01T00:00:00.000Z", "2000-01-01T01:00:00.000Z");
    const freshReadModel = readModelAt("2026-06-09T01:05:00.000Z", "2026-06-09T01:05:05.000Z");
    expect(laggedReadModel.healthTriage.freshness).toBe("unavailable");
    expect(freshReadModel.healthTriage.freshness).toBe("fresh");

    let loaderCallCount = 0;
    const secondLoaderCall = deferred<void>();

    const router = createMemoryRouter(
      [
        {
          path: "/catalog/providers/:providerKey",
          Component: CatalogProviderDetailRoute,
          loader: async () => {
            loaderCallCount += 1;
            if (loaderCallCount === 1) {
              return { readModel: laggedReadModel, commandFeedback: null, providerRefreshSchedules: [] };
            }
            await secondLoaderCall.promise;
            return { readModel: freshReadModel, commandFeedback: null, providerRefreshSchedules: [] };
          },
        },
      ],
      { initialEntries: ["/catalog/providers/tcgdex"] },
    );

    render(<RouterProvider router={router} />);

    const revalidateButton = await screen.findByRole("button", { name: "Refresh" });
    expect(loaderCallCount).toBe(1);
    expect(revalidateButton.getAttribute("aria-busy")).not.toBe("true");
    expect(revalidateButton.hasAttribute("disabled")).toBe(false);

    revalidateButton.click();

    // The second loader invocation is in flight (held open by secondLoaderCall)
    // — this is the real router transition's busy window, not a manually
    // constructed `revalidating` prop.
    await waitFor(() => {
      expect(loaderCallCount).toBe(2);
      expect(revalidateButton.getAttribute("aria-busy")).toBe("true");
      expect(revalidateButton.hasAttribute("disabled")).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBe(revalidateButton);

    secondLoaderCall.resolve();

    await waitFor(() => {
      expect(document.querySelector("[data-catalog-provider-detail-freshness]")?.getAttribute(
        "data-catalog-provider-detail-freshness",
      )).toBe("fresh");
      expect(document.querySelector('[data-catalog-provider-detail-revalidate="true"]')).toBeNull();
    });
  }, 20_000);
});
