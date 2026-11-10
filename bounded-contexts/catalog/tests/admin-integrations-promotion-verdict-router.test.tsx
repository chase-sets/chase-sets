// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IntegrationsRoute, { action, loader } from "../routes/admin/integrations";
import ScopeDetailRoute, { action as scopeAction } from "../routes/admin/scope-detail";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../features/source-observations/ui/primary-workbench-read-model";
import {
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
  syntheticPromotionPreviewResponse,
} from "../features/source-observations/ui/primary-workbench-test-fixtures";
import type { SourceObservationPromotionPreview } from "../features/source-observations/ui/contracts";

const { client } = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("../support/request-support/api-client", () => ({ createCatalogRequestApiClient: client }));
vi.mock("@chase-sets/platform-runtime/auth", () => ({
  resolveActorFromAuthApi: async () => ({ permissions: ["catalog.view", "catalog.manage"] }),
  isTransientAuthResolutionError: () => false,
}));

const base =
  "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04";
let router: ReturnType<typeof createMemoryRouter>;
beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});
afterEach(() => {
  router?.dispose();
  cleanup();
});

function model(location: string, ids: readonly string[]) {
  return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl: new URL(location, "https://admin.example"),
    scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
    profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
    controlPlaneOverview: null,
    canManageCatalog: true,
    reviewObservations: {
      items: ids.map((observation_id) => sourceObservationListItem({ observation_id })),
      total: ids.length,
      count: ids.length,
    },
  });
}

function openStage() {
  const stage = document.querySelector<HTMLButtonElement>('[data-catalog-import-workflow-stage="create-items"]')!;
  expect(stage).not.toBeNull();
  if (stage.getAttribute("aria-expanded") !== "true") fireEvent.click(stage);
}

function expectState(state: "fresh" | "stale" | "unavailable", enabled: boolean) {
  openStage();
  expect(
    document.querySelector(`[data-catalog-promotion-receipt-state="${state}"]`),
    JSON.stringify({
      state,
      actual: document
        .querySelector("[data-catalog-promotion-receipt-state]")
        ?.getAttribute("data-catalog-promotion-receipt-state"),
      actionPresent: Boolean(router.state.actionData?.workbench),
      navigation: router.state.navigation.state,
      revalidation: router.state.revalidation,
    }),
  ).not.toBeNull();
  const confirm = screen.getByLabelText(/I confirm this will promote/);
  expect(confirm.hasAttribute("disabled")).toBe(!enabled);
  if (enabled && !(confirm as HTMLInputElement).checked) fireEvent.click(confirm);
  expect(screen.getByRole("button", { name: "Create or update Catalog Items" }).hasAttribute("disabled")).toBe(
    !enabled,
  );
}

// P11175-R1-N01: real action and router states, no mocked router hooks.
describe("held promotion verdict router transitions", () => {
  it.each(["daily", "scope"] as const)(
    "binds %s pending, ready, revalidation and failed verdict reads",
    async (surface) => {
      const ids: string[] = [];
      let fingerprint = "synthetic-fingerprint-a";
      let fail = false;
      let release!: (preview: SourceObservationPromotionPreview) => void;
      let pending: Promise<SourceObservationPromotionPreview> | null = null;
      const models = new Map<string, ReturnType<typeof model>>();
      const stableModel = (location: string) => {
        if (!models.has(location)) models.set(location, model(location, ["obs_001"]));
        return models.get(location)!;
      };
      const read = vi.fn(async (_surface: string, location: string) => {
        const readModel = stableModel(location);
        if (new URL(location, "https://admin.example").searchParams.has("promotionPreviewId")) {
          if (fail) throw new Error("Synthetic verdict read failure");
          return {
            readModel: {
              ...readModel,
              promotionPreview: {
                ...readModel.promotionPreview,
                previewCommittable: true,
                currentFingerprint: fingerprint,
              },
            },
          };
        }
        return { readModel };
      });
      const preview = vi.fn(async () => pending ?? syntheticPromotionPreviewResponse());
      client.mockReturnValue({
        getCatalogPrimaryWorkbenchSurface: read,
        getCatalogPrimaryWorkbenchDeferredSourceOptions: async () => model(base, []).sourceOptions,
        getCatalogPrimaryWorkbenchDeferredImportPreview: async () => null,
        recordCatalogControlPlaneEvent: async () => ({ status: "recorded" }),
        previewBulkPromoteSourceObservations: preview,
      });
      const location =
        surface === "daily"
          ? base
          : base.replace("/catalog/integrations", "/catalog/scopes/synthetic-scope") + "&scopeRecordId=synthetic-scope";
      const routeLoader = async (args: Parameters<typeof loader>[0]) => {
        const journey = await loader(args);
        if (surface === "daily") return journey;
        return {
          journey,
          scope: {
            scopeRecordId: "synthetic-scope",
            name: "Synthetic scope",
            productDomain: "pokemon",
            scopeKind: "set",
            lifecycleStatus: "active",
            languageEditions: [],
          },
          languageEditionAliasReview: null,
          coverageMatrix: null,
          candidateReviewJobs: null,
        };
      };
      router = createMemoryRouter(
        [
          {
            id: "root",
            loader: () => ({ actor: { permissions: ["catalog.view", "catalog.manage"] } }),
            children: [
              {
                id: "workbench",
                path: surface === "daily" ? "/catalog/integrations" : "/catalog/scopes/:scopeRecordId",
                loader: routeLoader,
                action: surface === "daily" ? action : scopeAction,
                Component: surface === "daily" ? IntegrationsRoute : ScopeDetailRoute,
              },
            ],
          },
        ],
        { initialEntries: [location] },
      );
      await act(async () => {
        render(<RouterProvider router={router} />);
      });
      const submit = () =>
        router.navigate(location, {
          formMethod: "post",
          formData: new URLSearchParams({
            _intent: "observation.promote",
            promotionPhase: "preview",
            providerKey: "tcgdex",
            unitKey: "tcgdex:pokemon:card:import",
            importScope: "en:3:base:base1",
            profileVersion: "2026.06.04",
            selectedObservationIds: ids.join(","),
            ...(surface === "scope" ? { scopeRecordId: "synthetic-scope" } : {}),
          }),
        });
      await act(async () => {
        await submit();
      });
      expectState("fresh", true);
      pending = new Promise((resolve) => {
        release = resolve;
      });
      let submitted!: Promise<void>;
      await act(async () => {
        submitted = submit();
      });
      await waitFor(() => expect(router.state.navigation.state).toBe("submitting"));
      expectState("stale", false);
      await act(async () => {
        release(syntheticPromotionPreviewResponse());
        await submitted;
      });
      expectState("fresh", true);
      fingerprint = "loader-drift";
      read.mockImplementation(async (_surface, location) => ({
        readModel: {
          ...stableModel(location),
          promotionPreview: {
            ...stableModel(location).promotionPreview,
            currentFingerprint: fingerprint,
            previewCommittable: true,
          },
        },
      }));
      await act(async () => {
        await router.revalidate();
      });
      await waitFor(() => {
        expect(router.state.revalidation).toBe("idle");
        const data = router.state.loaderData.workbench;
        expect(
          (surface === "daily" ? data.readModel : data.journey.readModel).promotionPreview.currentFingerprint,
        ).toBe("loader-drift");
      });
      expect(router.state.actionData).toBeNull();
      expectState("unavailable", false);
      expect(document.querySelector("[data-catalog-promotion-receipt]")).toBeNull();
      fail = true;
      read.mockImplementation(async (_surface, location) => {
        if (new URL(location, "https://admin.example").searchParams.has("promotionPreviewId"))
          throw new Error("Synthetic failed verdict");
        return { readModel: stableModel(location) };
      });
      pending = null;
      await act(async () => {
        await submit();
      });
      expectState("stale", false);
      expect(router.state.location.search).not.toContain("promotionPreviewId");
      for (const element of document.querySelectorAll<HTMLAnchorElement | HTMLFormElement>("a[href],form[action]")) {
        expect(element.getAttribute("href") ?? element.getAttribute("action")).not.toContain("promotionPreviewId");
        expect(element.getAttribute("href") ?? element.getAttribute("action")).not.toContain("synthetic-preview-token");
      }
    },
  );
});
