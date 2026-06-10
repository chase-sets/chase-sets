// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalogPrimaryWorkbenchReadModel } from "./primary-workbench-read-model";
import { CatalogPrimaryWorkbenchPage } from "./primary-workbench-page";
import {
  controlPlaneOverview,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "./primary-workbench-test-fixtures";

describe("CatalogPrimaryWorkbenchPage", () => {
  afterEach(() => {
    cleanup();
    window.history.pushState({}, "", "/catalog/integrations");
  });

  it("puts provider import, Source Observation review, and promotion ahead of support workflows", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(
      screen.getByRole("heading", {
        name: "Pull provider data, review Source Observations, promote Catalog facts",
      }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Pull provider data/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("cell", { name: /Review Source Observations/i })).toBeTruthy();
    expect(screen.getByRole("cell", { name: /Preview Catalog promotion impact/i })).toBeTruthy();
    expect(screen.getByRole("cell", { name: /Promote into Catalog Items/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Promotion command plan" })).toBeTruthy();
    expect(screen.getByText("Matching filtered observations")).toBeTruthy();
    expect(screen.getByText("Reject requires a reason")).toBeTruthy();
    expect(screen.getByText("Defer keeps observations in review")).toBeTruthy();
    expect(screen.getByText("Reapply uses current active profile")).toBeTruthy();
    expect(screen.getByText("Replay uses original source profile version")).toBeTruthy();
    expect(
      screen.getByText("Rejects stale observation, profile, rollout, permission, and command input changes"),
    ).toBeTruthy();

    const navigation = screen.getByRole("navigation", { name: "Catalog control plane workflows" });
    expect(within(navigation).getByText("Primary workflow")).toBeTruthy();
    expect(within(navigation).getByText("Unblock provider data")).toBeTruthy();
    expect(within(navigation).getByText("Govern and recover")).toBeTruthy();
    expect(within(navigation).getByText("Verify release evidence")).toBeTruthy();
    expect(screen.queryByText("Old integrations surface")).toBeNull();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("honors a direct supporting workflow section without changing the default primary route", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=triage",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("link", { name: /Health triage/i }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Import to promotion workbench/i }).getAttribute("href")).toContain(
      "/catalog/integrations?",
    );
  });

  it("updates the browser URL from mobile workflow navigation while preserving route context", () => {
    window.history.pushState(
      {},
      "",
      "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&section=workbench",
    );
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: window.location.href,
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Choose Catalog workflow" }), {
      target: { value: "audit-evidence" },
    });

    expect(screen.getByRole("link", { name: /Audit evidence/i }).getAttribute("aria-current")).toBe("page");
    expect(window.location.pathname).toBe("/catalog/integrations");
    expect(window.location.search).toContain("section=evidence");
    expect(window.location.search).toContain("providerKey=tcgdex");
    expect(window.location.search).toContain("unitKey=tcgdex%3Apokemon%3Acard%3Aimport");
    expect(window.location.search).toContain("filter.status=changed");
    expect(window.location.search).toContain("returnPath=");
  });

  it("renders scoped durable import monitoring without hiding the primary provider pull", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Provider import operations" })).toBeTruthy();
    expect(screen.getByText("Expected observations")).toBeTruthy();
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
    expect(screen.getAllByText("import job job_001 is running (7/24).").length).toBeGreaterThan(0);
    expect(screen.getAllByText("7/24 work units, 29% complete").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Pull provider data/i })[0]?.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByRole("button", { name: "Cancel" }).length).toBeGreaterThan(0);

    const cancelForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="cancel-import-job"]',
    );
    expect(cancelForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("cancel-import-job");
    expect(cancelForm?.querySelector<HTMLInputElement>('input[name="jobId"]')?.value).toBe("job_001");

    const reviewLinks = screen.getAllByRole("link", { name: "Review observations" });
    expect(reviewLinks.some((link) => link.getAttribute("href")?.includes("section=source-observation-review"))).toBe(
      true,
    );
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("renders provider transport blockers with operator reason and next step copy", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        readiness: {
          ...baseOverview.readiness,
          units: [
            {
              ...baseOverview.readiness.units[0]!,
              transportReadiness: "blocked",
              diagnostics: [
                {
                  code: "provider-timeout",
                  severity: "error",
                  message: "Provider timeout while fetching payloads.",
                  unitKey: "tcgdex:pokemon:card:import",
                  retryAfterSeconds: null,
                  source: "provider-adapter",
                },
              ],
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getAllByText("Provider timeout").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/The adapter timed out before receiving a complete provider response/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Next: Retry the provider pull after checking health triage/i).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("provider-transport-timeout")).toBeNull();
  });

  it("renders Source Observation evidence rows, drawer details, and bulk selection without raw payloads", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: {
        items: [
          sourceObservationListItem({
            normalized: {
              ...sourceObservationListItem().normalized,
              name: "A very long provider supplied Charizard display name with release diagnostics attached",
            },
            status_reason: "Provider changed rarity evidence during the latest pull.",
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Source Observation review" })).toBeTruthy();
    expect(screen.getAllByText(/A very long provider supplied Charizard/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Provider payload withheld; normalized facts and provenance are redaction-safe.").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", {
        name: /Preview promotion: A very long provider supplied Charizard/i,
      }).length,
    ).toBeGreaterThan(0);

    const reviewModule = screen.getByRole("heading", { name: "Source Observation review" }).closest("section");
    expect(reviewModule).toBeTruthy();
    const checkbox = within(reviewModule as HTMLElement).getAllByRole("checkbox")[0];
    fireEvent.click(checkbox);

    expect(screen.getByText("1 observation(s) selected")).toBeTruthy();

    const evidenceButtons = screen.getAllByRole("button", { name: "Evidence" });
    fireEvent.click(evidenceButtons[evidenceButtons.length - 1]!);

    expect(screen.getByText(/Source provenance, normalized facts/)).toBeTruthy();
    expect(screen.getByText("Provider changed rarity evidence during the latest pull.")).toBeTruthy();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("submits primary workbench commands with clean intent and selected-observation context", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    const importForm = document.querySelector('form[data-catalog-primary-workbench-command="start-provider-import"]');
    expect(importForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("start-provider-import");
    expect(importForm?.querySelector<HTMLInputElement>('input[name="providerKey"]')?.value).toBe("tcgdex");
    expect(importForm?.getAttribute("action")).toContain("/catalog/integrations?");
    expect(importForm?.getAttribute("action")).not.toMatch(/raw-json|legacy|compat/i);

    const reviewModule = screen.getByRole("heading", { name: "Source Observation review" }).closest("section");
    const checkbox = within(reviewModule as HTMLElement).getAllByRole("checkbox")[0];
    fireEvent.click(checkbox);

    const selectedPreviewForm = Array.from(
      document.querySelectorAll<HTMLFormElement>('form[data-catalog-primary-workbench-command="preview-promotion"]'),
    ).find((form) => form.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value === "obs_001");
    const rejectForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="reject-source-observations"]',
    );

    expect(selectedPreviewForm).toBeTruthy();
    expect(rejectForm?.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value).toBe("obs_001");
    expect(rejectForm?.querySelector<HTMLInputElement>('input[name="reason"]')?.required).toBe(true);
  });

  it("renders explicit-row command scope and stale-preview blockers before promotion execution", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.03&filter.status=changed&selectedObservationIds=obs_missing&promotionPreviewId=preview_old",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Promotion command plan" })).toBeTruthy();
    expect(screen.getByText("Explicit selected observations")).toBeTruthy();
    expect(screen.getAllByText("Stale").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stale promotion preview").length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByRole("button", { name: "Promote Catalog facts" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("clears route-provided Source Observation selections when the review context changes", async () => {
    const selectedReadModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&selectedObservationIds=obs_001",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });
    const clearedReadModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    const { rerender } = render(<CatalogPrimaryWorkbenchPage readModel={selectedReadModel} />);

    expect(screen.getByText("1 observation(s) selected")).toBeTruthy();

    rerender(<CatalogPrimaryWorkbenchPage readModel={clearedReadModel} />);

    await waitFor(() => {
      expect(screen.queryByText("1 observation(s) selected")).toBeNull();
    });
  });

  it("renders denied row actions without exposing provider bypass controls", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      canManageCatalog: false,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Source Observation review" })).toBeTruthy();
    expect(
      screen
        .getAllByRole("button", { name: /Preview promotion: Charizard/i })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(screen.getAllByText("Permission denied").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/This operator account cannot run the requested Catalog command/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Next: Ask an admin to grant catalog.manage/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/all providers/i)).toBeNull();
  });
});
