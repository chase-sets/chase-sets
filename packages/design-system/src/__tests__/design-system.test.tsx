import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BottomNav, Button, Tabs, TopNav } from "../components/actions";
import { DataTable, DetailPanel, StatGrid } from "../components/data-display";
import { Dialog, ToastRegion } from "../components/feedback";
import {
  AdminShell,
  MarketplaceShell,
  MetricStrip,
  OrderSummary,
  Page,
  SearchResultsLayout
} from "../patterns/app-shells";
import { Container } from "../primitives/layout";
import { ChaseRoot } from "../theme/provider";
import { resolveThemeOverrideStyle, resolveThemeStyle } from "../theme/tokens";
import { resolveResponsiveClass } from "../utils/system";

function ControlledToastHarness() {
  const [open, setOpen] = useState(true);

  return (
    <ChaseRoot>
      <ToastRegion
        items={[
          {
            id: "controlled-toast",
            title: "Controlled toast",
            description: "Closes through caller state.",
            tone: "success",
            open,
            onOpenChange: setOpen
          }
        ]}
      />
    </ChaseRoot>
  );
}

function UncontrolledToastHarness() {
  return (
    <ChaseRoot>
      <ToastRegion
        items={[
          {
            id: "uncontrolled-toast",
            title: "Uncontrolled toast",
            description: "Closes without external state.",
            tone: "info"
          }
        ]}
      />
    </ChaseRoot>
  );
}

describe("design system", () => {
  const marketplaceNav = [
    { key: "browse", label: "Browse", icon: "search" as const }
  ];

  it("resolves theme variables", () => {
    const style = resolveThemeStyle({
      colors: {
        accent: "#000000"
      }
    });

    expect(style["--color-accent" as never]).toBe("#000000");
  });

  it("only injects explicit theme overrides for scoped runtime styles", () => {
    const style = resolveThemeOverrideStyle({
      typography: {
        body: "Instrument Sans"
      }
    });

    expect(style?.["--font-body" as never]).toBe("Instrument Sans");
    expect(style?.["--color-background" as never]).toBeUndefined();
  });

  it("renders safely on the server", () => {
    const markup = renderToString(
      <ChaseRoot>
        <Button>Ship it</Button>
      </ChaseRoot>
    );

    expect(markup).toContain("data-chase-theme");
    expect(markup).toContain('data-color-mode="system"');
    expect(markup).toContain("Ship it");
  });

  it("renders tab content", () => {
    render(
      <ChaseRoot>
        <Tabs
          items={[
            {
              value: "one",
              label: "One",
              content: <div>First tab</div>
            }
          ]}
        />
      </ChaseRoot>
    );

    expect(screen.getByText("First tab")).toBeTruthy();
  });

  it("renders empty state for empty data tables", () => {
    render(
      <DataTable
        rows={[]}
        columns={[
          {
            key: "name",
            header: "Name",
            cell: (row: { name: string }) => row.name
          }
        ]}
      />
    );

    expect(screen.getByText("Nothing to review")).toBeTruthy();
  });

  it("renders open dialogs", () => {
    render(
      <ChaseRoot>
        <Dialog open title="Review listing">
          Content body
        </Dialog>
      </ChaseRoot>
    );

    expect(screen.getByText("Review listing")).toBeTruthy();
    expect(screen.getByText("Content body")).toBeTruthy();
  });

  it("dismisses controlled toasts through caller state", async () => {
    render(<ControlledToastHarness />);

    expect(screen.getByText("Controlled toast")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Dismiss notification" })
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" })
    );

    await waitFor(() => {
      expect(screen.queryByText("Controlled toast")).toBeNull();
    });
  });

  it("dismisses uncontrolled toasts without external state", async () => {
    render(<UncontrolledToastHarness />);

    expect(screen.getByText("Uncontrolled toast")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Dismiss notification" })
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" })
    );

    await waitFor(() => {
      expect(screen.queryByText("Uncontrolled toast")).toBeNull();
    });
  });

  it("applies default vertical spacing between detail panel content blocks", () => {
    const markup = renderToString(
      <DetailPanel title="Panel">
        <div>First block</div>
        <div>Second block</div>
      </DetailPanel>
    );

    expect(markup).toContain("space-y-4");
    expect(markup).toContain("First block");
    expect(markup).toContain("Second block");
  });

  it("keeps stat grids at two columns by default on narrow rails", () => {
    const markup = renderToString(
      <StatGrid>
        <div>One</div>
        <div>Two</div>
      </StatGrid>
    );

    expect(markup).toContain("grid-cols-1");
    expect(markup).toContain("sm:grid-cols-2");
    expect(markup).not.toContain("xl:grid-cols-4");
  });

  it("renders order summaries without redundant top spacing on the total row", () => {
    const markup = renderToString(
      <OrderSummary
        lines={[
          {
            label: "Subtotal",
            value: "$24.00"
          }
        ]}
        total="$24.00"
      />
    );

    expect(markup).toContain("Total");
    expect(markup).toContain("border-t");
    expect(markup).toContain("pt-4");
    expect(markup).not.toContain(
      "mt-4 flex items-center justify-between border-t border-muted pt-4"
    );
  });

  it("renders metric strips with explicit xl four-column layouts", () => {
    const markup = renderToString(
      <MetricStrip
        items={[
          { label: "One", value: "1" },
          { label: "Two", value: "2" },
          { label: "Three", value: "3" },
          { label: "Four", value: "4" }
        ]}
      />
    );

    expect(markup).toContain("xl:grid-cols-4");
  });

  it("renders containers full width by default and allows width overrides", () => {
    const defaultMarkup = renderToString(<Container>Container body</Container>);
    const wideMarkup = renderToString(<Container width="wide">Container body</Container>);

    expect(defaultMarkup).toContain("max-w-none");
    expect(defaultMarkup).not.toContain("max-w-5xl");
    expect(defaultMarkup).not.toContain("max-w-7xl");
    expect(wideMarkup).toContain("max-w-7xl");
  });

  it("renders pages full width by default and allows width overrides", () => {
    const defaultMarkup = renderToString(<Page>Page body</Page>);
    const contentMarkup = renderToString(<Page width="content">Page body</Page>);

    expect(defaultMarkup).toContain("max-w-none");
    expect(defaultMarkup).not.toContain("max-w-7xl");
    expect(contentMarkup).toContain("max-w-5xl");
  });

  it("renders navigation full width by default and allows width overrides", () => {
    const topNavMarkup = renderToString(
      <TopNav items={marketplaceNav} activeKey="browse" />
    );
    const narrowTopNavMarkup = renderToString(
      <TopNav items={marketplaceNav} activeKey="browse" width="narrow" />
    );
    const bottomNavMarkup = renderToString(
      <BottomNav items={marketplaceNav} activeKey="browse" />
    );

    expect(topNavMarkup).toContain("max-w-none");
    expect(topNavMarkup).not.toContain("max-w-7xl");
    expect(narrowTopNavMarkup).toContain("max-w-3xl");
    expect(bottomNavMarkup).toContain("max-w-none");
    expect(bottomNavMarkup).not.toContain("max-w-lg");
  });

  it("renders bottom nav badges as icon overlays without changing label flow", () => {
    const markup = renderToString(
      <BottomNav
        items={[
          { key: "browse", label: "Browse", icon: "search" },
          { key: "cart", label: "Cart", icon: "cart", badge: "3" }
        ]}
        activeKey="cart"
      />
    );

    expect(markup).toContain("relative inline-flex h-5 w-5 items-center justify-center");
    expect(markup).toContain("absolute -right-2 -top-2 inline-flex min-h-4 min-w-4");
    expect(markup).toContain("aria-hidden=\"true\"");
    expect(markup).toContain("class=\"sr-only\"> 3</span>");
  });

  it("renders search results without a reserved desktop rail when filters are omitted", () => {
    const markup = renderToString(
      <SearchResultsLayout
        summary={<div>Listing summary</div>}
      >
        <div>Listing results</div>
      </SearchResultsLayout>
    );

    expect(markup).toContain("Listing summary");
    expect(markup).toContain("Listing results");
    expect(markup).not.toContain("lg:grid-cols-[18rem_minmax(0,1fr)]");
  });

  it("renders search results with a desktop rail when filters are provided", () => {
    const markup = renderToString(
      <SearchResultsLayout
        filters={<div>Filter rail</div>}
        summary={<div>Listing summary</div>}
      >
        <div>Listing results</div>
      </SearchResultsLayout>
    );

    expect(markup).toContain("Filter rail");
    expect(markup).toContain("Listing summary");
    expect(markup).toContain("Listing results");
    expect(markup).toContain("lg:grid-cols-[18rem_minmax(0,1fr)]");
  });

  it("renders marketplace content without a reserved desktop rail when the sidebar is omitted", () => {
    const markup = renderToString(
      <ChaseRoot>
        <MarketplaceShell
          brand={<div>Brand</div>}
          topNavItems={marketplaceNav}
          bottomNavItems={marketplaceNav}
          activeKey="browse"
        >
          <div>Marketplace body</div>
        </MarketplaceShell>
      </ChaseRoot>
    );

    expect(markup).toContain("Marketplace body");
    expect(markup).not.toContain("lg:grid-cols-[18rem_minmax(0,1fr)]");
  });

  it("renders shells full width by default and allows width overrides", () => {
    const defaultMarketplaceMarkup = renderToString(
      <ChaseRoot>
        <MarketplaceShell
          brand={<div>Brand</div>}
          topNavItems={marketplaceNav}
          bottomNavItems={marketplaceNav}
          activeKey="browse"
        >
          <div>Marketplace body</div>
        </MarketplaceShell>
      </ChaseRoot>
    );
    const wideMarketplaceMarkup = renderToString(
      <ChaseRoot>
        <MarketplaceShell
          brand={<div>Brand</div>}
          topNavItems={marketplaceNav}
          bottomNavItems={marketplaceNav}
          activeKey="browse"
          width="wide"
        >
          <div>Marketplace body</div>
        </MarketplaceShell>
      </ChaseRoot>
    );
    const defaultAdminMarkup = renderToString(
      <ChaseRoot>
        <AdminShell
          brand={<div>Brand</div>}
          navItems={marketplaceNav}
          activeKey="browse"
        >
          <div>Admin body</div>
        </AdminShell>
      </ChaseRoot>
    );
    const wideAdminMarkup = renderToString(
      <ChaseRoot>
        <AdminShell
          brand={<div>Brand</div>}
          navItems={marketplaceNav}
          activeKey="browse"
          width="wide"
        >
          <div>Admin body</div>
        </AdminShell>
      </ChaseRoot>
    );

    expect(defaultMarketplaceMarkup).toContain("max-w-none");
    expect(defaultMarketplaceMarkup).not.toContain("max-w-7xl");
    expect(wideMarketplaceMarkup).toContain("max-w-7xl");
    expect(defaultAdminMarkup).toContain("max-w-none");
    expect(defaultAdminMarkup).not.toContain("max-w-7xl");
    expect(wideAdminMarkup).toContain("max-w-7xl");
  });

  it("renders marketplace content with a desktop rail when the sidebar is provided", () => {
    const markup = renderToString(
      <ChaseRoot>
        <MarketplaceShell
          brand={<div>Brand</div>}
          topNavItems={marketplaceNav}
          bottomNavItems={marketplaceNav}
          activeKey="browse"
          sidebar={<div>Sidebar content</div>}
        >
          <div>Marketplace body</div>
        </MarketplaceShell>
      </ChaseRoot>
    );

    expect(markup).toContain("Sidebar content");
    expect(markup).toContain("Marketplace body");
    expect(markup).toContain("lg:grid-cols-[18rem_minmax(0,1fr)]");
  });

  it("resolves responsive classes from maps", () => {
    const result = resolveResponsiveClass(
      { base: "row", md: "column" },
      {
        row: {
          base: "flex-row",
          sm: "sm:flex-row",
          md: "md:flex-row",
          lg: "lg:flex-row",
          xl: "xl:flex-row",
          "2xl": "2xl:flex-row"
        },
        column: {
          base: "flex-col",
          sm: "sm:flex-col",
          md: "md:flex-col",
          lg: "lg:flex-col",
          xl: "xl:flex-col",
          "2xl": "2xl:flex-col"
        }
      }
    );

    expect(result).toContain("flex-row");
    expect(result).toContain("md:flex-col");
  });
});
