import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DenseAdminWorkbenchHeader,
  DenseAdminWorkbenchLayout,
  DenseAdminWorkbenchProof,
  EvidenceList,
  WorkbenchFormGrid,
  WorkbenchGrid,
  WorkbenchGridSpan,
  WorkbenchStack,
  WorkbenchValueList,
} from "../index";

const BREAKPOINT_MIN_WIDTH: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
};

function leadingBreakpointMinWidth(className: string): number {
  const match = /^(sm|md|lg|xl):/.exec(className);
  if (!match) {
    throw new Error(`Expected a responsive prefix on class "${className}"`);
  }
  return BREAKPOINT_MIN_WIDTH[match[1]!]!;
}

describe("DenseAdminWorkbenchProof", () => {
  it("keeps provider import to Source Observation promotion as the primary workflow", () => {
    render(<DenseAdminWorkbenchProof />);

    expect(
      screen.getByRole("heading", {
        name: "Import provider data, review Source Observations, promote Catalog facts",
        level: 1,
      }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Pull provider data" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("navigation", { name: "Catalog control plane sections" })).toBeTruthy();

    const nav = screen.getByRole("navigation", { name: "Catalog control plane sections" });
    const primaryGroup = within(nav)
      .getAllByRole("group", { name: "Primary workflow" })
      .find((group) => group.tagName === "DIV");

    if (!primaryGroup) {
      throw new Error("Expected desktop Primary workflow group");
    }
    expect(
      within(primaryGroup)
        .getByRole("link", { name: /Import to promotion/ })
        .getAttribute("href"),
    ).toContain("/admin/catalog/primary-workbench");
    expect(
      within(primaryGroup)
        .getByRole("link", { name: /Import to promotion/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("combobox", { name: "Choose Catalog workflow" })).toBeTruthy();
  });

  it("does not preserve the old integrations surface as a link or fallback", () => {
    render(<DenseAdminWorkbenchProof />);

    const retiredSurface = screen.getByRole("button", { name: /Old integrations surface/ }) as HTMLButtonElement;

    expect(retiredSurface.disabled).toBe(true);
    expect(screen.queryByRole("link", { name: /Old integrations surface/ })).toBeNull();
  });

  it("renders dense table rows with blocked, denied, degraded, stale, and long-path coverage", () => {
    render(<DenseAdminWorkbenchProof />);

    expect(screen.getAllByText("Source Observation").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/very-long-source-path-for-wrap-proof/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Denied").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Degraded").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stale").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Catalog writer role required").length).toBeGreaterThan(0);

    const deniedPreview = screen.getAllByRole("button", {
      name: /Promotion denied for Pokemon Scarlet and Violet Promo/,
    })[0] as HTMLButtonElement;
    expect(deniedPreview.disabled).toBe(true);
  });

  it("opens evidence side sheets with redacted facts, diagnostics, command previews, and audit references", async () => {
    const user = userEvent.setup();

    render(<DenseAdminWorkbenchProof />);

    const evidenceTrigger = screen.getAllByRole("button", { name: "Evidence" })[0]!;

    await user.click(evidenceTrigger);

    const sheet = await screen.findByRole("dialog", { name: /Evidence for 1999 Pokemon Base Set Charizard/ });
    expect(within(sheet).getByText("Redacted fact")).toBeTruthy();
    expect(within(sheet).getByText(/Provider facts normalized/)).toBeTruthy();
    expect(within(sheet).getByText("Diagnostics")).toBeTruthy();
    expect(within(sheet).getByText(/promoteObservation/)).toBeTruthy();
    expect(within(sheet).getByText(/audit:cat-import/)).toBeTruthy();

    await user.click(within(sheet).getByRole("button", { name: "Close evidence" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Evidence for 1999 Pokemon/ })).toBeNull());
    expect(document.activeElement).toBe(evidenceTrigger);
  });

  it("keeps bulk actions in one canonical bar with a configuration panel and clear action", async () => {
    const user = userEvent.setup();

    render(<DenseAdminWorkbenchProof />);

    expect(screen.getByText("2 Source Observations selected")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Configure preview" }));

    const panel = await screen.findByRole("dialog", { name: "Configure promotion preview" });
    expect(within(panel).getByText("Preview Catalog-owned writes before promotion commands run.")).toBeTruthy();
    expect(within(panel).getByText("Denied and stale observations fail closed.")).toBeTruthy();

    await user.click(within(panel).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configure promotion preview" })).toBeNull());

    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText("2 Source Observations selected")).toBeNull();
  });

  it("shows empty and loading proof states without hiding the primary import action", () => {
    const emptyMarkup = renderToString(<DenseAdminWorkbenchProof empty />);
    const loadingMarkup = renderToString(<DenseAdminWorkbenchProof loading />);

    expect(emptyMarkup).toContain("No Source Observations match this view");
    expect(emptyMarkup).toContain("Pull provider data");
    expect(emptyMarkup).toContain("Empty state");
    expect(emptyMarkup).not.toContain("2 Source Observations selected");
    expect(loadingMarkup).toContain("animate-pulse");
    expect(loadingMarkup).toContain("Provider transport is degraded");
  });

  it("renders the proof as a responsive design-system artifact instead of a Catalog runtime page", () => {
    const markup = renderToString(<DenseAdminWorkbenchProof />);

    expect(markup).toContain('data-proof-artifact="dense-admin-workbench"');
    expect(markup).toContain("md:grid-cols-[18rem_minmax(0,1fr)]");
    expect(markup).toContain("md:hidden");
    expect(markup).toContain("hidden md:block");
    expect(markup).not.toContain("/admin/catalog/integrations");
  });

  it("keeps dense workbench gap labels mapped to canonical SpaceToken classes", () => {
    expect(renderToString(<WorkbenchStack gap="sm">Compact</WorkbenchStack>)).toContain("gap-2");
    expect(renderToString(<WorkbenchStack gap="md">Default</WorkbenchStack>)).toContain("gap-4");
    expect(renderToString(<WorkbenchStack gap="lg">Roomy</WorkbenchStack>)).toContain("gap-5");
    expect(renderToString(<WorkbenchGrid>Default grid</WorkbenchGrid>)).toContain("gap-4");
    expect(renderToString(<WorkbenchGrid gap="lg">Roomy grid</WorkbenchGrid>)).toContain("gap-5");
  });

  it("maps dense workbench regular density alias to comfortable", () => {
    const comfortableValues = renderToString(
      <WorkbenchValueList density="comfortable">
        <span>Fact</span>
      </WorkbenchValueList>,
    );
    const regularValues = renderToString(
      <WorkbenchValueList density="regular">
        <span>Fact</span>
      </WorkbenchValueList>,
    );
    const regularEvidence = renderToString(
      <EvidenceList title="Evidence" density="regular" items={[{ key: "proof", description: "Covered" }]} />,
    );

    expect(regularValues).toBe(comfortableValues);
    expect(comfortableValues).toContain("gap-2");
    expect(regularEvidence).toContain("p-3");
  });

  it("gives WorkbenchGrid two-pane variants tablet parity at lg: while dense three-up variants stay xl:", () => {
    expect(renderToString(<WorkbenchGrid columns="two">Two</WorkbenchGrid>)).toContain("lg:grid-cols-2");
    expect(renderToString(<WorkbenchGrid columns="detail">Detail</WorkbenchGrid>)).toContain(
      "lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]",
    );
    expect(renderToString(<WorkbenchGrid columns="sidebar">Sidebar</WorkbenchGrid>)).toContain(
      "lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]",
    );
    expect(renderToString(<WorkbenchGrid columns="three">Three</WorkbenchGrid>)).toContain("xl:grid-cols-3");
    expect(renderToString(<WorkbenchGrid columns="equalDetail">Equal detail</WorkbenchGrid>)).toContain(
      "xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(18rem,24rem)]",
    );
  });

  it("keeps the WorkbenchFormGrid column ladder monotonic — three never activates before two", () => {
    const twoMarkup = renderToString(<WorkbenchFormGrid columns="two">Two</WorkbenchFormGrid>);
    const threeMarkup = renderToString(<WorkbenchFormGrid columns="three">Three</WorkbenchFormGrid>);

    expect(twoMarkup).toContain("md:grid-cols-2");
    expect(threeMarkup).toContain("lg:grid-cols-3");

    const twoClass = /md:grid-cols-2/.exec(twoMarkup)![0]!;
    const threeClass = /lg:grid-cols-3/.exec(threeMarkup)![0]!;
    expect(leadingBreakpointMinWidth(threeClass)).toBeGreaterThanOrEqual(leadingBreakpointMinWidth(twoClass));
  });

  it("aligns WorkbenchGridSpan spans with the grid breakpoints they pair with", () => {
    expect(renderToString(<WorkbenchGridSpan columns={2}>Two-col span</WorkbenchGridSpan>)).toContain("lg:col-span-2");
    expect(renderToString(<WorkbenchGridSpan columns={3}>Three-col span</WorkbenchGridSpan>)).toContain(
      "xl:col-span-3",
    );
  });

  it("gives the header and layout shells the md: tablet two-column treatment", () => {
    const headerMarkup = renderToString(
      <DenseAdminWorkbenchHeader title="Title" actions={<button type="button">Action</button>} />,
    );
    expect(headerMarkup).toContain("md:grid-cols-[minmax(0,1fr)_auto]");
    expect(headerMarkup).toContain("md:items-end");

    const layoutMarkup = renderToString(
      <DenseAdminWorkbenchLayout
        navigationGroups={[]}
        activeNavigationKey="section"
        navigationLabel="Sections"
        mobileNavigationLabel="Sections"
      >
        Content
      </DenseAdminWorkbenchLayout>,
    );
    expect(layoutMarkup).toContain("md:grid-cols-[18rem_minmax(0,1fr)]");
    expect(layoutMarkup).toContain("md:items-start");
    // The rail offset must track the shell header var: below lg the admin shell
    // adds a sticky section bar to the header band, so a fixed md:top-20 would
    // pin the rail underneath it at tablet widths.
    expect(layoutMarkup).toContain("md:top-[calc(var(--shell-header-height,4rem)+1rem)]");
    expect(layoutMarkup).not.toContain("md:top-20");
  });
});
