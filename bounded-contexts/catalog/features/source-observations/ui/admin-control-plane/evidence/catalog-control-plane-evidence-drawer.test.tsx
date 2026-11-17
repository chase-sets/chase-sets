// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { CatalogControlPlaneEvidenceDrawer } from "./catalog-control-plane-evidence-drawer";
import { CatalogControlPlaneSettingsPage } from "../settings/catalog-control-plane-settings-page";
import { CatalogProviderDetailPage } from "../provider-detail/provider-detail-page";
import { CatalogIntegrationsSurfacePage } from "../../integrations-surface-page";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../primary-workbench-read-model";
import {
  controlPlaneOverview,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "../../primary-workbench-test-fixtures";

afterEach(cleanup);

function evidence() {
  return buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
    requestUrl:
      "https://admin.example/catalog/scopes/scope-base?providerKey=tcgdex&evidenceRef=source-observation/obs_001&reviewOffset=25",
    scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
    profileReviews: { items: [profileReview()], total: 1, count: 1 },
    controlPlaneOverview: controlPlaneOverview(),
    reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
    canManageCatalog: true,
  }).auditEvidence;
}

describe("Catalog entity evidence drawer", () => {
  it.each(["daily", "health"] as const)("mounts the generated %s job href on its drawer owner", (surface) => {
    const input = {
      requestUrl: `https://admin.example/catalog/integrations${surface === "health" ? "/health" : ""}?providerKey=tcgdex&reviewOffset=25${surface === "daily" ? "&evidenceRef=import-job/job_001" : ""}`,
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview()], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    };
    const generated = buildCatalogPrimaryWorkbenchReadModelForSurface(surface, input);
    const href = generated.auditEvidence.timeline.find((row) => row.targetType === "import-job")!.evidenceLinks[0]!
      .href;
    const model = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      ...input,
      requestUrl: new URL(href, "https://admin.example").href,
    });
    const router = createMemoryRouter(
      [
        { path: "/catalog/providers/:providerKey", element: <CatalogProviderDetailPage readModel={model} /> },
        {
          path: "/catalog/integrations",
          element: <CatalogIntegrationsSurfacePage surface="daily" readModel={model} />,
        },
        {
          path: "/catalog/integrations/health",
          element: <CatalogIntegrationsSurfacePage surface="health" readModel={model} />,
        },
      ],
      { initialEntries: [href] },
    );
    try {
      render(<RouterProvider router={router} />);
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(document.querySelector("[data-catalog-provider-detail]")).toBeTruthy();
      expect(document.querySelector("[data-catalog-audit-evidence-workspace]")).toBeNull();
      expect(model.auditEvidence.selection).toEqual({
        reference: "import-job/job_001",
        state: "resolved",
        deepLinkOpen: true,
      });
      expect(model.auditEvidence.timeline.every((row) => row.jobId === "job_001")).toBe(true);
      const url = new URL(href, "https://admin.example");
      expect(url.pathname).toBe("/catalog/providers/tcgdex");
      expect(url.searchParams.get("reviewOffset")).toBe("25");
      expect(url.searchParams.get("providerKey")).toBe("tcgdex");
    } finally {
      router.dispose();
    }
  });

  it("preserves the review probe's positive Provider drawer control", () => {
    const model = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/providers/tcgdex?evidenceRef=provider/tcgdex",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview()], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });
    render(<CatalogProviderDetailPage readModel={model} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(model.auditEvidence.selection).toMatchObject({ state: "resolved", deepLinkOpen: true });
  });

  it("routes generated control-plane evidence from the old governance surface to Settings", async () => {
    const input = {
      requestUrl:
        "https://admin.example/catalog/integrations/governance?evidenceRef=control-plane/settings&reviewOffset=25",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [], total: 0, count: 0 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    };
    const generated = buildCatalogPrimaryWorkbenchReadModelForSurface("governance", input);
    const href = generated.auditEvidence.evidenceLinks[0]!.href;
    const url = new URL(href, "https://admin.example");
    expect(url.pathname).toBe("/catalog/integrations/settings");
    expect(url.searchParams.get("evidenceRef")).toBe("control-plane/settings");
    expect(url.searchParams.get("reviewOffset")).toBe("25");
    const model = buildCatalogPrimaryWorkbenchReadModelForSurface("governance", {
      ...input,
      requestUrl: url,
    });
    render(<CatalogControlPlaneSettingsPage readModel={model} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close evidence" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("[data-catalog-control-plane-settings-page]")).toBeTruthy();
  });
  it("opens a resolved deep link over its host and closes without changing its context", async () => {
    const audit = evidence();
    render(
      <>
        <h1>Scope host with held review page</h1>
        <CatalogControlPlaneEvidenceDrawer auditEvidence={audit} />
      </>,
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("source-observation-changed").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("redacted").length).toBeGreaterThan(0);
    const links = within(dialog).getAllByRole("link");
    expect(links.every((link) => link.getAttribute("href")?.startsWith("/catalog/scopes/scope-base?"))).toBe(true);
    await userEvent.click(within(dialog).getByRole("button", { name: "Close evidence" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Scope host with held review page" })).toBeTruthy();
    expect(audit.returnToPrimaryHref).toContain("reviewOffset=25");
  });

  it("does not auto-open an unresolved reference and shows no association rather than unrelated history", async () => {
    const audit = evidence();
    render(
      <CatalogControlPlaneEvidenceDrawer
        auditEvidence={{
          ...audit,
          selection: { reference: "source-observation/missing", state: "no-associated-evidence", deepLinkOpen: false },
          timeline: [],
          evidenceLinks: [],
        }}
        deepLinkOpen
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Audit timeline" }));
    expect(screen.getByText("No associated evidence")).toBeTruthy();
    expect(screen.queryByText("source-observation-changed")).toBeNull();
  });

  it.each([
    ["ready", "Audit timeline is ready"],
    ["partial", "Audit projection is partial"],
    ["blocked", "Audit timeline is blocked"],
    ["unavailable", "Audit projection is unavailable"],
  ] as const)("visibly distinguishes %s from loaded-empty", (status, title) => {
    const audit = evidence();
    render(<CatalogControlPlaneEvidenceDrawer auditEvidence={{ ...audit, status, timeline: [], evidenceLinks: [] }} />);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText("No timeline events")).toBeTruthy();
    expect(screen.queryByText("No associated evidence")).toBeNull();
  });
});
