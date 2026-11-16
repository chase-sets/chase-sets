// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogControlPlaneEvidenceDrawer } from "./catalog-control-plane-evidence-drawer";
import { CatalogControlPlaneSettingsPage } from "../settings/catalog-control-plane-settings-page";
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
  it("mounts the existing Settings launch with validated control-plane deep-link context", async () => {
    const model = buildCatalogPrimaryWorkbenchReadModelForSurface("governance", {
      requestUrl: "https://admin.example/catalog/integrations/settings?evidenceRef=control-plane/settings",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [], total: 0, count: 0 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
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
