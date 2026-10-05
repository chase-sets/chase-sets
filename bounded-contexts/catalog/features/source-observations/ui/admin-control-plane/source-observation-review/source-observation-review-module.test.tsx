// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLoaderData } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { CatalogIntegrationSourceObservationReviewModule } from "./source-observation-review-module";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../primary-workbench-read-model";
import {
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "../../primary-workbench-test-fixtures";
import { loadSourceObservationEvidence } from "../../../../../support/route-support/admin-integrations/observation-evidence-loader";
import { ApiError } from "../../../../../support/shell-support/api/client";
import { loadDailySurfaceForRequest } from "../../../../../support/route-support/admin-integrations/integrations-loader-support";

const { createApi } = vi.hoisted(() => ({ createApi: vi.fn() }));
vi.mock("../../../../../support/request-support/api-client", () => ({ createCatalogRequestApiClient: createApi }));
vi.mock("@chase-sets/platform-runtime/auth", () => ({
  resolveActorFromAuthApi: async () => ({ permissions: ["catalog.manage"] }),
  isTransientAuthResolutionError: () => false,
}));
afterEach(cleanup);

describe("Source Observation review evidence data router", () => {
  it.each(["success", "missing", "error", "unauthorized", "forbidden", "network"] as const)(
    "keeps %s evidence inside the open row sheet",
    async (outcome) => {
      const observation = sourceObservationListItem({
        observation_id: "synthetic-jungle-pikachu",
        status: "promoted",
        normalized: {
          ...sourceObservationListItem().normalized,
          name: "Pikachu",
          setId: "base2",
          expansionName: "Jungle",
        },
      });
      let settle!: () => void;
      const pending = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const getObservation = vi.fn(async () => {
        await pending;
        if (outcome === "network") throw new TypeError("Synthetic network failure");
        if (outcome !== "success")
          throw new ApiError(
            outcome === "missing" ? 404 : outcome === "unauthorized" ? 401 : outcome === "forbidden" ? 403 : 503,
            { error: "Synthetic evidence failure" },
          );
        return observation;
      });
      createApi.mockReturnValue({
        getSourceObservation: getObservation,
        listProductContentTypes: async () => ({ items: [] }),
        listProductContentInclusionPolicies: async () => ({ items: [] }),
      });
      const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
        requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&languageCode=en&expansionId=base2",
        scopes: {
          items: [
            sourceObservationScope({ expansion_id: "base2", expansion_name: "Jungle", promoted_observations: 1 }),
          ],
          total: 1,
          count: 1,
        },
        profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
        controlPlaneOverview: null,
        canManageCatalog: true,
        reviewObservations: { items: [observation], total: 1, count: 1 },
      });
      const requests: string[] = [];
      const router = createMemoryRouter(
        [
          {
            path: "/catalog/integrations",
            element: (
              <CatalogIntegrationSourceObservationReviewModule
                readModel={readModel}
                selectedObservationKeys={new Set()}
                onSelectedObservationKeysChange={() => undefined}
                selectedEligibleObservationCount={0}
                selectedReviewableObservationCount={0}
              />
            ),
            errorElement: <div data-testid="escaped-evidence-error">Evidence failure escaped to route boundary</div>,
          },
          {
            path: "/catalog/integrations/observation-evidence/:id",
            loader: (args) => {
              requests.push(args.request.url);
              return loadSourceObservationEvidence(args);
            },
          },
        ],
        { initialEntries: ["/catalog/integrations"] },
      );
      render(
        <ChaseRoot linkComponent={RouterLinkAdapter}>
          <RouterProvider router={router} />
        </ChaseRoot>,
      );
      expect(screen.getByRole("radio", { name: "Promoted (1)" })).not.toBeNull();
      fireEvent.click(screen.getAllByRole("button", { name: "Evidence" })[0]!);
      await waitFor(() =>
        expect(document.querySelector('[data-catalog-observation-evidence="loading"]')).not.toBeNull(),
      );
      expect(screen.getByRole("dialog").textContent).toContain("Pikachu");
      settle();
      await waitFor(() =>
        expect(
          document.querySelector(
            '[data-catalog-observation-evidence="loaded"], [data-catalog-observation-evidence="error"], [data-testid="escaped-evidence-error"]',
          ),
        ).not.toBeNull(),
      );
      expect(requests).toEqual(["http://localhost/catalog/integrations/observation-evidence/synthetic-jungle-pikachu"]);
      expect(getObservation).toHaveBeenCalledWith("synthetic-jungle-pikachu");
      expect(getObservation).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("escaped-evidence-error")).toBeNull();
      expect(screen.getByRole("radiogroup", { hidden: true })).not.toBeNull();
      expect(screen.getByRole("dialog").textContent).toContain("Pikachu");
      expect(
        document.querySelector(`[data-catalog-observation-evidence="${outcome === "success" ? "loaded" : "error"}"]`),
      ).not.toBeNull();
      router.dispose();
    },
  );
});

function LoadedReview() {
  const { readModel } = useLoaderData<Awaited<ReturnType<typeof loadDailySurfaceForRequest>>>();
  return (
    <CatalogIntegrationSourceObservationReviewModule
      readModel={readModel}
      selectedObservationKeys={new Set()}
      onSelectedObservationKeysChange={() => undefined}
      selectedEligibleObservationCount={0}
      selectedReviewableObservationCount={0}
    />
  );
}

const selectedScopeUrl =
  "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&languageCode=en&expansionId=base2";

function mockReviewApi({ empty = false, unavailable = false, noPromoted = false } = {}) {
  const observations = (["observed", "changed", "promoted", "rejected"] as const).map((status) =>
    sourceObservationListItem({
      observation_id: `synthetic-${status}`,
      status,
      normalized: {
        ...sourceObservationListItem().normalized,
        name: status === "promoted" ? "Pikachu" : `Synthetic ${status}`,
        setId: "base2",
        expansionName: "Jungle",
      },
    }),
  );
  const list = vi.fn(async (query: string) => {
    if (unavailable) throw new ApiError(503, {});
    const params = new URLSearchParams(query);
    const status = params.get("status");
    const rows = empty
      ? []
      : observations.filter(
          (row) =>
            (!noPromoted || row.status !== "promoted") &&
            (!status || (status === "eligible" ? ["observed", "changed"].includes(row.status) : row.status === status)),
        );
    const offset = Number(params.get("offset"));
    return { items: rows.slice(offset, offset + Number(params.get("limit"))), total: rows.length, count: rows.length };
  });
  createApi.mockReturnValue({
    listSourceObservationIntegrationScopes: async () => ({
      items: [
        sourceObservationScope({
          expansion_id: "base2",
          expansion_name: "Jungle",
          observed_observations: empty ? 0 : 3,
          changed_observations: empty ? 0 : 4,
          promoted_observations: empty || noPromoted ? 0 : 1,
          rejected_observations: empty ? 0 : noPromoted ? 5 : 4,
          total_observations: empty ? 0 : 12,
        }),
      ],
      total: 1,
      count: 1,
    }),
    listSourceObservationProviderProfiles: async () => ({
      items: [profileReview({ active: true, lifecycle: "active" })],
      total: 1,
      count: 1,
    }),
    getCatalogIntegrationControlPlaneOverview: async () => null,
    listSourceObservations: list,
    listCatalogMergeCandidates: async () => ({ items: [], total: 0, count: 0 }),
    recordCatalogControlPlaneEvent: async () => ({ status: "recorded" }),
    listSourceObservationIntegrationOptions: async () => {
      throw new Error("Synthetic unavailable cached options");
    },
  });
  return list;
}

function renderLoadedReview(url: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/catalog/integrations",
        loader: ({ request }) => loadDailySurfaceForRequest(request),
        element: <LoadedReview />,
      },
    ],
    { initialEntries: [url] },
  );
  const view = render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
  return { router, view };
}

async function selectStatus(router: ReturnType<typeof createMemoryRouter>, label: string) {
  await act(async () => {
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = router.subscribe((state) => {
        if (state.navigation.state === "idle") {
          unsubscribe();
          resolve();
        }
      });
    });
    fireEvent.click(screen.getByRole("radio", { name: label }));
    await settled;
  });
  expect(screen.getByRole("radio", { name: label, checked: true })).not.toBeNull();
}

describe("Source Observation status navigation through the daily loader", () => {
  it("defaults to All and keeps every status, count, scope and reset offset through reload and history", async () => {
    const list = mockReviewApi();
    const { router, view } = renderLoadedReview(`${selectedScopeUrl}&reviewOffset=25`);
    await screen.findByRole("radio", { name: "All (12)", checked: true });
    expect(new URLSearchParams(list.mock.calls[0]![0]).get("offset")).toBe("25");
    for (const [label, status, names] of [
      ["Observed (3)", "observed", ["Synthetic observed"]],
      ["Eligible (7)", "eligible", ["Synthetic observed", "Synthetic changed"]],
      ["Promoted (1)", "promoted", ["Pikachu"]],
      ["Rejected (4)", "rejected", ["Synthetic rejected"]],
      ["All (12)", null, ["Synthetic observed", "Synthetic changed", "Pikachu", "Synthetic rejected"]],
    ] as const) {
      await selectStatus(router, label);
      const params = new URLSearchParams(router.state.location.search);
      expect(params.get("filter.status")).toBe(status);
      expect(params.has("reviewOffset")).toBe(false);
      expect(params.get("providerKey")).toBe("tcgdex");
      expect(params.get("expansionId")).toBe("base2");
      for (const name of names) expect(screen.getAllByText(name).length).toBeGreaterThan(0);
      if (status === "eligible") expect(screen.queryByText("Pikachu")).toBeNull();
      const query = new URLSearchParams(list.mock.lastCall![0]);
      expect(query.get("status")).toBe(status);
      expect(query.get("offset")).toBe("0");
      expect(query.get("limit")).toBe("25");
    }
    await act(() => router.navigate(-1));
    await screen.findByRole("radio", { name: "Rejected (4)", checked: true });
    await act(() => router.navigate(1));
    await screen.findByRole("radio", { name: "All (12)", checked: true });
    await selectStatus(router, "Promoted (1)");
    const reloadedUrl = router.state.location.pathname + router.state.location.search;
    view.unmount();
    router.dispose();
    const reloaded = renderLoadedReview(reloadedUrl);
    await screen.findByRole("radio", { name: "Promoted (1)", checked: true });
    expect(screen.getAllByText("Pikachu").length).toBeGreaterThan(0);
    reloaded.router.dispose();
  });

  it.each(["narrowed", "empty", "unavailable"] as const)("distinguishes the %s empty state", async (state) => {
    mockReviewApi({ empty: state === "empty", unavailable: state === "unavailable", noPromoted: state === "narrowed" });
    const { router } = renderLoadedReview(`${selectedScopeUrl}&filter.status=promoted`);
    await screen.findByRole("radio", { name: /^Promoted/ });
    if (state === "narrowed") {
      expect(screen.getByRole("radio", { name: "Promoted (0)", checked: true })).not.toBeNull();
      expect(screen.getByText(/No promoted observations in .*Jungle.*\(12 in this scope\)/)).not.toBeNull();
      expect(screen.queryByText("No Source Observations in this context")).toBeNull();
    } else {
      expect(screen.getByText("No Source Observations in this context")).not.toBeNull();
      expect(screen.queryByText(/No promoted observations in/)).toBeNull();
    }
    const data = Object.values(router.state.loaderData)[0] as Awaited<ReturnType<typeof loadDailySurfaceForRequest>>;
    expect(data.readModel.sourceObservationReview.freshness).toBe(state === "unavailable" ? "unavailable" : "fresh");
    router.dispose();
  });
});
