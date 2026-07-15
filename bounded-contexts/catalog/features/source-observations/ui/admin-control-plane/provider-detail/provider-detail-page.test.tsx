// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../primary-workbench-read-model";
import { controlPlaneOverview, profileReview, sourceObservationScope } from "../../primary-workbench-test-fixtures";
import { CatalogProviderDetailPage } from "./provider-detail-page";
import { catalogProviderDetailHref } from "./provider-detail-links";

afterEach(() => {
  cleanup();
});

describe("CatalogProviderDetailPage", () => {
  it("renders provider identity, the active profile, clone draft, and version history on one page", () => {
    const profile = profileReview({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
      active: true,
      lifecycle: "active",
      referenceCount: 3,
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex&profileVersion=2026.06.04",
      scopes: { items: [sourceObservationScope({ provider_key: "tcgdex" })], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(
      <CatalogProviderDetailPage
        readModel={readModel}
        providerRefreshSchedules={[
          {
            providerKey: "tcgdex",
            scheduleEnabled: true,
            manualOnly: false,
            creditAware: false,
            intervalMs: 21_600_000,
            paused: false,
            pausedBy: null,
            nextRunAt: "2026-07-14T18:00:00.000Z",
            lastRunCompletedAt: "2026-07-14T12:00:00.000Z",
            lastRunStatus: "succeeded",
            lastRunError: null,
          },
        ]}
      />,
    );

    // Identity header.
    expect(screen.getAllByText("tcgdex").length).toBeGreaterThan(0);
    // Active profile overview (reused ProfileOverviewEvidence).
    expect(screen.getByRole("heading", { name: "Profile overview" })).toBeTruthy();
    expect(screen.getAllByText("tcgdex-pokemon-card").length).toBeGreaterThan(0);

    // Clone-draft form posts back to this page (never /catalog/integrations/providers).
    const cloneForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="provider-profile.clone"]',
    );
    expect(cloneForm).toBeTruthy();
    expect(new URL(cloneForm!.getAttribute("action") ?? "", "https://admin.example").pathname).toBe(
      "/catalog/providers/tcgdex",
    );
    expect(cloneForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("provider-profile.clone");

    // Version history table with the active profile listed.
    expect(screen.getByRole("heading", { name: "Profile candidates" })).toBeTruthy();
    expect(screen.getAllByText(/tcgdex-pokemon-card@2026.06.04/).length).toBeGreaterThan(0);
    expect(screen.getByText("Scheduled source-option refresh")).toBeTruthy();
    expect(screen.getByText(/Last run: Succeeded/)).toBeTruthy();
    const runNowForm = document
      .querySelector<HTMLInputElement>('input[name="_intent"][value="run-provider-refresh"]')
      ?.closest("form");
    const action = new URL(runNowForm?.getAttribute("action") ?? "", "https://admin.example");
    expect(action.pathname).toBe("/catalog/providers/tcgdex");
    expect(action.searchParams.get("profileVersion")).toBe("2026.06.04");
  });

  it("renders rollback/deprecate/retire as row-level lifecycle actions that submit back to this page", () => {
    const profile = profileReview({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
      active: true,
      lifecycle: "active",
      referenceCount: 0,
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex&profileVersion=2026.06.04",
      scopes: { items: [sourceObservationScope({ provider_key: "tcgdex" })], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(<CatalogProviderDetailPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Deprecate profile" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Retire profile" })).toBeTruthy();

    const deprecateForm = document.querySelector<HTMLFormElement>('form[data-catalog-lifecycle-command="deprecate"]');
    expect(deprecateForm).toBeTruthy();
    expect(new URL(deprecateForm!.getAttribute("action") ?? "", "https://admin.example").pathname).toBe(
      "/catalog/providers/tcgdex",
    );
    expect(deprecateForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe(
      "provider-profile.deprecate",
    );
    expect(deprecateForm?.querySelector<HTMLInputElement>('input[name="providerKey"]')?.value).toBe("tcgdex");
    expect(deprecateForm?.querySelector<HTMLInputElement>('input[name="profileVersion"]')?.value).toBe("2026.06.04");
  });

  it("renders credential and transport readiness on the header from health-triage evidence", () => {
    const baseOverview = controlPlaneOverview();
    const profile = profileReview({ providerKey: "tcgdex", active: true, lifecycle: "active" });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex",
      scopes: { items: [sourceObservationScope({ provider_key: "tcgdex" })], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: baseOverview,
      canManageCatalog: true,
    });

    render(<CatalogProviderDetailPage readModel={readModel} />);

    // The header renders inline instead of forcing a detour to the retired
    // standalone health-triage workspace. The page title and the header module
    // both name the provider, so at least two headings render "tcgdex".
    expect(screen.getAllByRole("heading", { name: "tcgdex" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(screen.getByText("Catalog semantic readiness")).toBeTruthy();
    expect(screen.getByText("Provider transport readiness")).toBeTruthy();
    expect(screen.getAllByText("Freshness").length).toBeGreaterThan(0);
    expect(screen.queryByText(/health-triage/i)).toBeNull();
  });

  it("shows an empty state when no provider is selected", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/providers",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [], total: 0, count: 0 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogProviderDetailPage readModel={readModel} />);

    expect(screen.getByText("No provider selected")).toBeTruthy();
  });

  it("renders the command-feedback banner in place after a redirect back from a command", () => {
    const profile = profileReview({ providerKey: "tcgdex", active: true, lifecycle: "active" });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex",
      scopes: { items: [sourceObservationScope({ provider_key: "tcgdex" })], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(
      <CatalogProviderDetailPage
        readModel={readModel}
        commandFeedback={{ status: "success", intent: "provider-profile.activate", result: "profile-activated" }}
      />,
    );

    expect(screen.getAllByText(/activat/i).length).toBeGreaterThan(0);
  });
});

describe("catalogProviderDetailHref", () => {
  it("builds a path-param href with no returnPath/section detour state", () => {
    const href = catalogProviderDetailHref("tcgdex", { profileVersion: "2026.06.04" });
    const url = new URL(href, "https://admin.example");

    expect(url.pathname).toBe("/catalog/providers/tcgdex");
    expect(url.searchParams.get("profileVersion")).toBe("2026.06.04");
    expect(url.searchParams.has("returnPath")).toBe(false);
    expect(url.searchParams.has("section")).toBe(false);
  });

  it("falls back to the bare providers path when no provider is selected", () => {
    expect(catalogProviderDetailHref(null)).toBe("/catalog/providers");
  });

  it("percent-encodes the provider key path segment", () => {
    const href = catalogProviderDetailHref("tcg dex");
    expect(href).toBe("/catalog/providers/tcg%20dex");
  });
});
