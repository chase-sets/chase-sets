import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BottomNav, Button, CopyButton, SegmentedControl, Tabs, TopNav } from "../components/actions";
import { Card, DataTable, DetailPanel, FilterBar, ImageGallery, StatGrid } from "../components/data-display";
import { Accordion, Dialog, Rating, ToastRegion } from "../components/feedback";
import { Combobox, NativeSelect, PasswordInput, SearchInput, TagInput } from "../components/forms";
import { Reveal, Stagger, ViewTransition } from "../motion/primitives";
import { ChaseSetsLogo, chaseSetsLogoSvg } from "../brand/chase-sets-logo";
import {
  AdminShell,
  CommerceActionBar,
  CommerceDrawer,
  FormPanel,
  MarketStatusBadge,
  MarketplaceFacetRail,
  MarketplaceLandingHero,
  MarketplaceMarketSummary,
  MarketplaceProductDetailLayout,
  MarketplaceProductCard,
  MarketplaceShell,
  MetricStrip,
  OrderSummary,
  Page,
  ProductCard,
  SearchResultsLayout,
  SellerBadge,
  SplitPane,
  TokenSwatch,
  Wizard
} from "../patterns/app-shells";
import { Container, Grid, SkipLink } from "../primitives/layout";
import { ChaseRoot, ColorModeToggle, useChaseMotion, useReducedMotion } from "../theme/provider";
import { resolveThemeOverrideStyle, resolveThemeStyle } from "../theme/tokens";
import { resolveResponsiveClass, resolveSpaceClass } from "../utils/system";

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

function MotionStatus() {
  const reducedMotion = useReducedMotion();
  const motionSettings = useChaseMotion();

  return (
    <div>
      <span>{reducedMotion ? "reduced" : "full"}</span>
      <span>{motionSettings.reducedMotionSetting}</span>
    </div>
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

  it("supports explicit reduced motion policy overrides", () => {
    render(
      <ChaseRoot reducedMotion="always">
        <MotionStatus />
      </ChaseRoot>
    );

    expect(screen.getByText("reduced")).toBeTruthy();
    expect(screen.getByText("always")).toBeTruthy();
  });

  it("resolves the user reduced motion policy from matchMedia", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () => ({
        matches: true,
        addEventListener: () => {},
        removeEventListener: () => {}
      })
    });

    render(
      <ChaseRoot>
        <MotionStatus />
      </ChaseRoot>
    );

    expect(screen.getByText("reduced")).toBeTruthy();
    expect(screen.getByText("user")).toBeTruthy();
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

  it("uses motion-safe scroll areas for overlay content", () => {
    render(
      <ChaseRoot>
        <Dialog open title="Review listing">
          Content body
        </Dialog>
      </ChaseRoot>
    );

    expect(document.querySelector(".motion-safe-scroll-area")?.textContent)
      .toContain("Content body");

    render(
      <ChaseRoot>
        <Combobox
          label="Condition"
          items={[{ value: "nm", label: "Near Mint" }]}
        />
      </ChaseRoot>
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Condition" }));

    expect(screen.getByRole("listbox").getAttribute("class"))
      .toContain("motion-safe-scroll-area");
  });

  it("renders motion primitives safely on the server", () => {
    const markup = renderToString(
      <ChaseRoot reducedMotion="never">
        <Stagger>
          <Reveal preset="lift">
            <div>Animated card</div>
          </Reveal>
          <ViewTransition transitionKey="search">
            <div>Animated page</div>
          </ViewTransition>
        </Stagger>
      </ChaseRoot>
    );

    expect(markup).toContain("Animated card");
    expect(markup).toContain("Animated page");
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
    const expandedMarkup = renderToString(
      <Container width="expanded">Container body</Container>
    );

    expect(defaultMarkup).toContain("max-w-none");
    expect(defaultMarkup).not.toContain("max-w-5xl");
    expect(defaultMarkup).not.toContain("max-w-7xl");
    expect(wideMarkup).toContain("max-w-7xl");
    expect(expandedMarkup).toContain("max-w-screen-2xl");
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

  it("renders the Chase Sets logo and uses it in seller badges", () => {
    const logoMarkup = renderToString(<ChaseSetsLogo title="Chase Sets logo" />);
    const badgeMarkup = renderToString(<SellerBadge name="Chase Sets" verified />);

    expect(chaseSetsLogoSvg).toContain("logoGradient");
    expect(logoMarkup).toContain('role="img"');
    expect(logoMarkup).toContain("Chase Sets logo");
    expect(badgeMarkup).toContain("Chase Sets");
    expect(badgeMarkup).toContain("Verified");
    expect(badgeMarkup).toContain("<svg");
  });

  it("allows filter bars to opt out of sticky positioning", () => {
    const stickyMarkup = renderToString(<FilterBar>Sticky filters</FilterBar>);
    const staticMarkup = renderToString(<FilterBar sticky={false}>Static filters</FilterBar>);

    expect(stickyMarkup).toContain("sticky");
    expect(stickyMarkup).toContain("top-16");
    expect(staticMarkup).not.toContain("sticky");
    expect(staticMarkup).not.toContain("top-16");
  });

  it("renders split panes with named rail widths and optional sticky rails", () => {
    const markup = renderToString(
      <SplitPane
        primary={<div>Primary content</div>}
        secondary={<div>Secondary rail</div>}
        secondaryWidth="summary"
        secondarySticky
      />
    );

    expect(markup).toContain("Primary content");
    expect(markup).toContain("Secondary rail");
    expect(markup).toContain("lg:grid-cols-[minmax(0,1fr)_24rem]");
    expect(markup).toContain("lg:sticky lg:top-24 lg:self-start");
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

  it("renders marketplace product details with expanded desktop content columns", () => {
    const markup = renderToString(
      <MarketplaceProductDetailLayout
        summary={<div>Summary</div>}
        media={<div>Media</div>}
        market={<div>Market metrics</div>}
        commerce={<div>Commerce</div>}
      >
        <div>Detail content</div>
      </MarketplaceProductDetailLayout>
    );

    expect(markup).toContain(
      "xl:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)_24rem]"
    );
    expect(markup).toContain(
      "2xl:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)_26rem]"
    );
    expect(markup).toContain("space-y-6");
    expect(markup).toContain("Market metrics");
    expect(markup).toContain("Detail content");
  });

  it("renders marketplace market summaries as compact buyer signals", () => {
    const markup = renderToString(
      <MarketplaceMarketSummary
        price="$21.50"
        note="Raw / Excellent"
        facts={[
          { label: "Available", value: "3" },
          { label: "Sellers", value: "1" }
        ]}
      />
    );

    expect(markup).toContain("$21.50");
    expect(markup).toContain("Raw / Excellent");
    expect(markup).toContain("Available");
    expect(markup).toContain("Sellers");
    expect(markup).toContain("lg:flex-row");
  });

  it("renders commerce action bars with optional intent controls", () => {
    const markup = renderToString(
      <CommerceActionBar
        intentControl={
          <SegmentedControl
            fullWidth
            aria-label="Choose intent"
            items={[
              { value: "buy", label: "Buy" },
              { value: "sell", label: "Sell" }
            ]}
            value="buy"
          />
        }
        summary="Raw / Near Mint"
        primaryAction={<button type="button">Buy</button>}
        secondaryAction={<button type="button">Make offer</button>}
      />
    );

    expect(markup).toContain("Choose intent");
    expect(markup).toContain("grid w-full grid-flow-col");
    expect(markup).toContain("Raw / Near Mint");
    expect(markup).toContain("grid-cols-2");
    expect(markup).toContain("Make offer");
  });

  it("renders form panels as card or drawer-native surfaces", () => {
    const cardMarkup = renderToString(
      <FormPanel glow>
        Form body
      </FormPanel>
    );
    const plainMarkup = renderToString(
      <FormPanel variant="plain">
        Form body
      </FormPanel>
    );

    expect(cardMarkup).toContain("glass-surface");
    expect(plainMarkup).toContain("Form body");
    expect(plainMarkup).not.toContain("glass-surface");
  });

  it("renders commerce drawers with form footer actions", () => {
    render(
      <ChaseRoot>
        <CommerceDrawer
          open
          title="Buy selected product"
          description="Raw / Near Mint"
          footer={<Button form="commerce-form" type="submit">Buy now</Button>}
        >
          <form id="commerce-form">Quantity</form>
        </CommerceDrawer>
      </ChaseRoot>
    );

    const drawer = screen.getByRole("dialog", { name: "Buy selected product" });
    expect(within(drawer).getByText("Quantity")).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Buy now" })).toBeTruthy();
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

  it("resolves spacing classes from static maps", () => {
    expect(resolveSpaceClass("gap", 5)).toBe("gap-5");
    expect(resolveSpaceClass("p", 6)).toBe("p-6");
    expect(resolveSpaceClass("px", 12)).toBe("px-12");
  });

  it("renders Rating with correct number of stars", () => {
    const markup = renderToString(<Rating value={3} max={5} label="Product rating" />);

    expect(markup).toContain("aria-label=\"Product rating\"");
    // 3 filled stars have fill="currentColor", 2 empty stars do not
    const filledCount = (markup.match(/fill="currentColor"/g) || []).length;
    expect(filledCount).toBe(3);
  });

  it("renders interactive Rating with radio role", () => {
    render(
      <ChaseRoot>
        <Rating value={3} max={5} interactive label="Rate this" />
      </ChaseRoot>
    );

    expect(screen.getByRole("radiogroup")).toBeTruthy();
  });

  it("renders Accordion items", () => {
    render(
      <ChaseRoot>
        <Accordion
          type="single"
          collapsible
          items={[
            { value: "item1", trigger: "Section 1", content: <div>Content 1</div> },
            { value: "item2", trigger: "Section 2", content: <div>Content 2</div> }
          ]}
        />
      </ChaseRoot>
    );

    expect(screen.getByText("Section 1")).toBeTruthy();
    expect(screen.getByText("Section 2")).toBeTruthy();
  });

  it("renders ImageGallery with thumbnails", () => {
    const markup = renderToString(
      <ImageGallery
        images={[
          { src: "/img1.jpg", alt: "Front" },
          { src: "/img2.jpg", alt: "Back" }
        ]}
      />
    );

    expect(markup).toContain("Front");
    expect(markup).toContain("Back");
  });

  it("renders ImageGallery empty states inside the gallery frame", () => {
    const markup = renderToString(
      <ImageGallery
        images={[]}
        emptyState={<div>Gallery placeholder</div>}
      />
    );

    expect(markup).toContain("Gallery placeholder");
    expect(markup).toContain("modern-surface");
    expect(markup).toContain("flex items-center justify-center");
  });

  it("renders ImageGallery fallback imagery when no images are provided", () => {
    const markup = renderToString(
      <ImageGallery
        images={[]}
        fallbackImage={{ src: "/fallback-card-back.png", alt: "Card back" }}
        emptyState={<div>Gallery placeholder</div>}
      />
    );

    expect(markup).toContain('src="/fallback-card-back.png"');
    expect(markup).toContain('alt="Card back"');
  });

  it("renders ImageGallery with desktop height constraints when configured", () => {
    const markup = renderToString(
      <ImageGallery
        images={[{ src: "/img1.jpg", alt: "Front" }]}
        maxHeightClassName="lg:[--gallery-max-height:min(70vh,34rem)]"
      />
    );

    expect(markup).toContain("lg:[--gallery-max-height:min(70vh,34rem)]");
    expect(markup).toContain("lg:h-[var(--gallery-max-height)]");
    expect(markup).toContain("lg:w-[min(100%,calc(var(--gallery-max-height)*var(--gallery-aspect-ratio)))]");
  });

  it("renders CopyButton with label", () => {
    render(
      <ChaseRoot>
        <CopyButton value="test-value" label="Copy ID" />
      </ChaseRoot>
    );

    expect(screen.getByText("Copy ID")).toBeTruthy();
  });

  it("renders TagInput with tag values", () => {
    render(
      <ChaseRoot>
        <TagInput values={["Pokemon", "Charizard"]} placeholder="Add tag" />
      </ChaseRoot>
    );

    expect(screen.getByText("Pokemon")).toBeTruthy();
    expect(screen.getByText("Charizard")).toBeTruthy();
  });

  it("renders PasswordInput with visibility toggle", () => {
    render(
      <ChaseRoot>
        <PasswordInput label="Password" />
      </ChaseRoot>
    );

    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show password" })).toBeTruthy();
  });

  it("renders SkipLink with target and label", () => {
    const markup = renderToString(<SkipLink targetId="main" label="Skip navigation" />);

    expect(markup).toContain('href="#main"');
    expect(markup).toContain("Skip navigation");
    expect(markup).toContain("sr-only");
  });

  it("renders Card with media slot", () => {
    const markup = renderToString(
      <Card media={<img src="/card.jpg" alt="Card" />}>
        <div>Card content</div>
      </Card>
    );

    expect(markup).toContain("Card content");
    expect(markup).toContain('alt="Card"');
  });

  it("renders Card with interactive styles", () => {
    const markup = renderToString(
      <Card interactive>
        <div>Clickable card</div>
      </Card>
    );

    expect(markup).toContain("Clickable card");
    expect(markup).toContain("cursor-pointer");
  });

  it("renders Grid alignment variants", () => {
    const markup = renderToString(
      <Grid columns={{ base: 1, md: 4 }} align="start" justify="center">
        <div>Aligned child</div>
      </Grid>
    );

    expect(markup).toContain("md:grid-cols-4");
    expect(markup).toContain("items-start");
    expect(markup).toContain("justify-center");
  });

  it("renders ProductCard with contained image fit", () => {
    const markup = renderToString(
      <ProductCard
        title="2020 Pikachu VMAX"
        subtitle="PSA 10"
        price="$1,250"
        imageSrc="/demo-assets/pikachu-card.svg"
        imageAlt="Pikachu card"
        imageFit="contain"
      />
    );

    expect(markup).toContain("2020 Pikachu VMAX");
    expect(markup).toContain('alt="Pikachu card"');
    expect(markup).toContain("object-contain");
  });

  it("swaps ProductCard to the fallback image when the primary image fails", () => {
    render(
      <ChaseRoot>
        <ProductCard
          title="2020 Pikachu VMAX"
          imageSrc="/missing-card.png"
          imageAlt="Pikachu card"
          fallbackImageSrc="/pokemon-card-back.png"
          fallbackImageAlt="Pokemon card back"
        />
      </ChaseRoot>
    );

    fireEvent.error(screen.getByAltText("Pikachu card"));

    const fallbackImage = screen.getByAltText("Pokemon card back");
    expect(fallbackImage.getAttribute("src")).toBe("/pokemon-card-back.png");
  });

  it("renders ProductCard as a link when href is provided", () => {
    const markup = renderToString(
      <ProductCard
        href="/items/pikachu"
        title="2020 Pikachu VMAX"
        price="$1,250"
      />
    );

    expect(markup).toContain("<a");
    expect(markup).toContain('href="/items/pikachu"');
    expect(markup).toContain("2020 Pikachu VMAX");
  });

  it("renders ProductCard as a button when onSelect is provided", () => {
    render(
      <ChaseRoot>
        <ProductCard
          title="Selectable card"
          selectLabel="Open selectable card"
          onSelect={() => {}}
        />
      </ChaseRoot>
    );

    expect(screen.getByRole("button", { name: "Open selectable card" })).toBeTruthy();
  });

  it("renders marketplace product cards with canonical status and action language", () => {
    const markup = renderToString(
      <MarketplaceProductCard
        href="/items/pikachu"
        title="Pikachu"
        subtitle="Jungle 60/64"
        description="Classic electric single"
        status="available"
        price="From $21.50"
        meta="3 listings • 5 available"
        actionLabel="View listings"
        categoryTags={["Pokemon TCG", "Singles"]}
        metadataTags={["jungle", "pikachu"]}
      />
    );

    expect(markup).toContain("Available now");
    expect(markup).toContain("From $21.50");
    expect(markup).toContain("View listings");
    expect(markup).toContain("Pokemon TCG");
  });

  it("renders marketplace facet rails and landing heroes from design-system patterns", () => {
    const facetMarkup = renderToString(
      <MarketplaceFacetRail
        items={[{ id: "pokemon", label: "Pokemon TCG", count: 7 }]}
        selectedId="pokemon"
        onSelect={() => {}}
      />
    );
    const heroMarkup = renderToString(
      <MarketplaceLandingHero
        badges={[{ label: "Verified supply", tone: "success" }]}
        title="Find collectibles worth chasing."
        description="Search live supply and compare active markets."
        search={<SearchInput hideLabel label="Search" />}
        filters={[{ id: "", label: "All", selected: true, onSelect: () => {} }]}
        metrics={[{ label: "Available Now", value: 3, detail: "With active listings" }]}
      />
    );
    const statusMarkup = renderToString(<MarketStatusBadge status="marketOnly" />);

    expect(facetMarkup).toContain("Browse Categories");
    expect(facetMarkup).toContain("Pokemon TCG (7)");
    expect(heroMarkup).toContain("Find collectibles worth chasing.");
    expect(heroMarkup).toContain("Available Now");
    expect(statusMarkup).toContain("Market only");
  });

  it("renders token swatches for the spec board", () => {
    const markup = renderToString(
      <TokenSwatch label="Primary Blue" value="#3882F6" color="brandPrimary" />
    );

    expect(markup).toContain("Primary Blue");
    expect(markup).toContain("#3882F6");
    expect(markup).toContain("bg-accent");
  });

  it("renders NativeSelect with accessible label and placeholder", () => {
    render(
      <ChaseRoot>
        <NativeSelect
          label="Condition"
          placeholder="Choose condition"
          items={[{ value: "nm", label: "Near Mint" }]}
        />
      </ChaseRoot>
    );

    expect(screen.getByLabelText("Condition")).toBeTruthy();
    expect(screen.getByText("Choose condition")).toBeTruthy();
  });

  it("renders DataTable with sortable column headers", () => {
    const markup = renderToString(
      <DataTable
        rows={[{ name: "Alpha", price: 10 }]}
        columns={[
          { key: "name", header: "Name", cell: (r: { name: string }) => r.name, sortable: true },
          { key: "price", header: "Price", cell: (r: { price: number }) => r.price }
        ]}
        sortKey="name"
        sortDirection="asc"
        onSortChange={() => {}}
      />
    );

    expect(markup).toContain("Alpha");
    // Sortable header renders as a button
    expect(markup).toContain("<button");
    expect(markup).toContain("Name");
  });

  it("renders ColorModeToggle with current mode label", () => {
    render(
      <ChaseRoot>
        <ColorModeToggle value="dark" onValueChange={() => {}} />
      </ChaseRoot>
    );

    expect(screen.getByText("Dark")).toBeTruthy();
  });

  it("renders Wizard with step content", () => {
    const markup = renderToString(
      <Wizard
        steps={[
          { key: "step1", label: "First", content: <div>Step 1 content</div> },
          { key: "step2", label: "Second", content: <div>Step 2 content</div> }
        ]}
        activeStep="step1"
        onStepChange={() => {}}
      />
    );

    expect(markup).toContain("Step 1 content");
    expect(markup).toContain("First");
    expect(markup).toContain("Second");
  });

  it("renders marketplace shells with a main landmark and skip link target", () => {
    render(
      <ChaseRoot>
        <MarketplaceShell
          brand={<div>Brand</div>}
          topNavItems={marketplaceNav}
          bottomNavItems={marketplaceNav}
          activeKey="browse"
        >
          <div>Body</div>
        </MarketplaceShell>
      </ChaseRoot>
    );

    expect(screen.getByRole("main").getAttribute("id")).toBe("main-content");
    expect(
      screen.getByRole("link", { name: "Skip to main content" }).getAttribute("href")
    ).toBe("#main-content");
  });

  it("renders admin shells with a main landmark and skip link target", () => {
    render(
      <ChaseRoot>
        <AdminShell
          brand={<div>Brand</div>}
          navItems={marketplaceNav}
          activeKey="browse"
        >
          <div>Body</div>
        </AdminShell>
      </ChaseRoot>
    );

    expect(screen.getByRole("main").getAttribute("id")).toBe("main-content");
    expect(
      screen.getByRole("link", { name: "Skip to main content" }).getAttribute("href")
    ).toBe("#main-content");
  });

  it("renders i18n props with custom labels", () => {
    const markup = renderToString(
      <OrderSummary
        lines={[{ label: "Subtotal", value: "$10" }]}
        total="$10"
        totalLabel="Grand Total"
      />
    );

    expect(markup).toContain("Grand Total");
    expect(markup).not.toContain(">Total<");
  });
});
