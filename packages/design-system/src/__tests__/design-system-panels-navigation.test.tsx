import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act, type MouseEvent, useState } from "react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as DesignSystem from "../index";
import {
  COLLAPSE_FLOOR,
  DIRECTION_DELTA,
  SEED_PHASE,
  SEARCH_ROW_EVENT_TYPES,
  createInitialSearchRowState,
  observeSearchRowEvents,
  searchRowPolicy,
  searchRowReducer,
  type SearchRowEnvironment,
  type SearchRowEvent,
  type SearchRowEventType,
  type SearchRowObservation,
  type SearchRowState,
} from "../patterns/app-shells/search-row-phase";
import type { ReactNode } from "react";
import { ThemeToggle } from "../theme/theme-toggle";
import {
  BottomSheet,
  BottomNav,
  Badge,
  CommerceSheet,
  Button,
  Dialog,
  NavigationHeader,
  SideNav,
  TopNav,
  ThemePreferenceControl,
  SideSheet,
  ActivitySheet,
  AssistantSheet,
  ComparisonModule,
  FullPage,
  ModalDialog,
  NavigationDrawer,
  ResponsiveActionMenu,
  Sidebar,
  StickyCtaBar,
  StickyTaskFooter,
  Tabs,
  TaskLineItem,
  TaskProgress,
  TaskSummary,
  WorkflowActionBar,
  WorkflowModule,
  WorkflowReadinessChecklist,
  AddressBlock,
  ChecklistCard,
  OperationalLockBanner,
  WorkstationLayout,
  QuantityChecklistControl,
  MarketplaceProductDetailLayout,
  MarketplaceEmptyState,
  MarketplaceStatusTimeline,
  MarketplaceTemplateGallery,
  MessageThreadPreview,
  OfferCard,
  TaskReference,
  TaskScanInput,
  ProductMediaModule,
  ResponsiveEditSheet,
  ReferenceInfoDialog,
  ReferenceInfoTrigger,
  ReviewCard,
  AccountProfileHeader,
  ChaseRoot,
  MarketplaceShell,
  Table,
} from "../index";

describe("design system panels, navigation, and shells", () => {
  it("keeps promoted survivors on the root surface and removed compat helpers off it", () => {
    const surface = DesignSystem as Record<string, unknown>;

    expect(surface.NavigationHeader).toBe(NavigationHeader);
    expect(surface.Progress).toBeTypeOf("function");
    expect(surface.ThemePreferenceControl).toBe(ThemePreferenceControl);
    expect(surface.ThemeToggle).toBeUndefined();
    expect(surface.cn).toBeUndefined();
    expect(surface.UiBadge).toBeUndefined();
    expect(surface.UiCard).toBeUndefined();
  });

  it("renders canonical panel interaction components", async () => {
    const user = userEvent.setup();

    render(
      <div>
        <NavigationDrawer
          trigger={<Button>Open navigation</Button>}
          label="Workspace navigation"
          items={[
            { key: "dashboard", label: "Dashboard", href: "/dashboard" },
            { key: "reports", label: "Reports", href: "/reports" },
          ]}
          activeKey="dashboard"
        />
        <SideSheet
          trigger={<Button>Open customer details</Button>}
          title="Customer details"
          description="Inspect the selected customer."
        >
          Customer history
        </SideSheet>
        <BottomSheet
          trigger={<Button>Open mobile filters</Button>}
          title="Mobile filters"
          description="Refine the result set."
          height="expanded"
        >
          Filter controls
        </BottomSheet>
        <ModalDialog
          trigger={<Button>Delete report</Button>}
          title="Delete report"
          description="This action cannot be undone."
        >
          Confirm delete
        </ModalDialog>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(await screen.findByRole("dialog", { name: "Workspace navigation" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Open customer details" }));
    expect(await screen.findByRole("dialog", { name: "Customer details" })).toBeTruthy();
    expect(screen.getByText("Customer history")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Open mobile filters" }));
    expect(await screen.findByRole("dialog", { name: "Mobile filters" })).toBeTruthy();
    expect(screen.getByText("Filter controls")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Delete report" }));
    expect(await screen.findByRole("dialog", { name: "Delete report" })).toBeTruthy();
    expect(screen.getByText("Confirm delete")).toBeTruthy();
  });

  it("pins the bottom-sheet placement's per-breakpoint geometry, including the lg:hidden desktop cutoff", () => {
    render(
      <ChaseRoot>
        <BottomSheet open title="Mobile filters">
          Filter controls
        </BottomSheet>
      </ChaseRoot>,
    );

    const sheet = screen.getByRole("dialog", { name: "Mobile filters" });

    // Mobile-band placement: anchored to the bottom edge with a 3-unit inset.
    expect(sheet.className).toContain("inset-x-3");
    expect(sheet.className).toContain("bottom-3");
    // Tablet-band placement widens the inset but keeps the sheet anchored to the bottom.
    expect(sheet.className).toContain("md:inset-x-6");
    expect(sheet.className).toContain("md:bottom-6");
    // The frame carries no lg:+ replacement geometry of its own — BottomSheet consumers
    // must pair every sheet with a desktop-visible alternative (see BottomSheet's JSDoc).
    expect(sheet.className).toContain("lg:hidden");
  });

  it("renders responsive marketplace sheet wrappers", async () => {
    const user = userEvent.setup();

    render(
      <div>
        <CommerceSheet
          trigger={<Button>Preview cart action</Button>}
          title="Add matching products"
          description="Review eligible products without leaving search."
        >
          Bulk add preview
        </CommerceSheet>
        <ResponsiveEditSheet
          trigger={<Button>Edit shipping address</Button>}
          title="Update address"
          description="Edit the saved destination."
        >
          Address form
        </ResponsiveEditSheet>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Preview cart action" }));
    expect(await screen.findByRole("dialog", { name: "Add matching products" })).toBeTruthy();
    expect(screen.getByText("Bulk add preview")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Edit shipping address" }));
    expect(await screen.findByRole("dialog", { name: "Update address" })).toBeTruthy();
    expect(screen.getByText("Address form")).toBeTruthy();
  });

  it("promotes long action menus to mobile bottom sheets", async () => {
    const user = userEvent.setup();
    const onPause = vi.fn();

    render(
      <ResponsiveActionMenu
        trigger={<Button>More actions</Button>}
        menuLabel="Listing actions"
        sheetDescription="Choose an action for this listing."
        items={[
          { key: "share", label: "Share", icon: "share" },
          { key: "duplicate", label: "Duplicate listing", icon: "copy" },
          { key: "edit", label: "Edit listing", href: "/account/listings/listing_1" },
          { key: "pause", label: "Pause listing", onSelect: onPause },
          { key: "withdraw", label: "Withdraw listing", destructive: true },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));

    const sheet = await screen.findByRole("dialog", { name: "Listing actions" });
    expect(sheet).toBeTruthy();
    expect(screen.getByText("Choose an action for this listing.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit listing" }).getAttribute("href")).toBe("/account/listings/listing_1");

    await user.click(screen.getByRole("button", { name: "Pause listing" }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it("renders named support sheets for activity and assistant panels", () => {
    const markup = renderToString(
      <div>
        <ActivitySheet open mobileModal={false} title="Listing activity">
          Price changed
        </ActivitySheet>
        <AssistantSheet open mobileModal={false} title="Marketplace assistant">
          Suggested next step
        </AssistantSheet>
      </div>,
    );

    expect(markup).toContain("Listing activity");
    expect(markup).toContain("Price changed");
    expect(markup).toContain("Marketplace assistant");
    expect(markup).toContain("Suggested next step");
  });

  it("renders non-modal panel regions and full-page flows on the server", () => {
    const markup = renderToString(
      <div>
        <Sidebar
          title="Admin navigation"
          items={[{ key: "feedback", label: "Platform Feedback", href: "/platform-feedback" }]}
          activeKey="feedback"
        />
        <SideSheet modal={false} title="Activity" description="Recent changes.">
          Activity feed
        </SideSheet>
        <BottomSheet modal={false} title="Share options" height="compact">
          Copy link
        </BottomSheet>
        <FullPage title="Create report" description="Build a marketplace report.">
          Report builder
        </FullPage>
      </div>,
    );

    expect(markup).toContain("Admin navigation");
    expect(markup).toContain("Platform Feedback");
    expect(markup).toContain("Activity feed");
    expect(markup).toContain("Share options");
    expect(markup).toContain("Create report");
    expect(markup).toContain("Report builder");
  });

  it("renders sticky checkout CTAs without hiding context", () => {
    const markup = renderToString(
      <StickyCtaBar
        price="$472.19"
        context="Final total before payment"
        primaryAction={<Button>Continue to payment</Button>}
        secondaryAction={<Button tone="secondary">Edit cart</Button>}
      />,
    );

    expect(markup).toContain("$472.19");
    expect(markup).toContain('data-primary-action-count="1"');
    expect(markup).toContain("Final total before payment");
    expect(markup).toContain("Continue to payment");
    expect(markup).toContain("Edit cart");
  });

  it("renders operational workstation patterns for task completion flows", () => {
    const markup = renderToString(
      <WorkstationLayout
        secondaryTitle="Shipment details"
        secondary={
          <div>
            <TaskSummary
              title="Fulfillment summary"
              items={[
                { label: "Status", value: "Packing" },
                { label: "Items", value: "1 item across 1 line" },
              ]}
            />
            <AddressBlock title="Ship to" lines={["Buyer", "2 Market St", "Chicago, IL 60601"]} copyValue="Buyer" />
          </div>
        }
        primary={
          <div>
            <OperationalLockBanner title="Order changes locked while packing" description="Started today." />
            <TaskScanInput
              label="Scan or search"
              value=""
              buttonLabel="Confirm"
              onValueChange={() => undefined}
              onSubmit={() => undefined}
              placeholder="Line, order line, product, or title"
            />
            <ChecklistCard
              title="Item checklist"
              progress={<TaskProgress label="1 of 1 checked" value={100} valueLabel="100%" tone="success" />}
            >
              <TaskLineItem
                title="Charizard"
                subtitle="Base Set"
                quantity={1}
                quantityControl={
                  <QuantityChecklistControl
                    value={1}
                    total={1}
                    decreaseLabel="Decrease packed quantity"
                    increaseLabel="Increase packed quantity"
                  />
                }
                checked
                checkboxLabel="Packed 1 x Charizard"
                reference={<TaskReference label="Order" value="oli_1" displayValue="OLI_1" />}
              />
            </ChecklistCard>
            <StickyTaskFooter summary="1 of 1 checked">
              <Button>Finish packing</Button>
            </StickyTaskFooter>
          </div>
        }
      />,
    );

    expect(markup).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]");
    expect(markup).toContain("Order changes locked while packing");
    expect(markup).toContain("Packed 1 x Charizard");
    expect(markup).toContain("Line, order line, product, or title");
    expect(markup).toContain("bottom-[calc(4.75rem+env(safe-area-inset-bottom))]");
  });

  it("renders dense workflow modules with status, actions, and readiness checks", () => {
    const markup = renderToString(
      <WorkflowModule
        title="Activation readiness"
        description="Review blocking checks before activation."
        status={<Badge tone="warning">Blocked</Badge>}
        actions={
          <>
            <Button tone="secondary" size="sm">
              Evidence
            </Button>
            <Button size="sm">Activate</Button>
          </>
        }
      >
        <WorkflowReadinessChecklist
          items={[
            {
              key: "fixture",
              label: "Fixture coverage",
              status: "passed",
              statusLabel: "Passed",
              description: "All required fixture flows include sample payloads.",
              meta: <TaskReference label="Profile" value="profile_tcgdx" displayValue="TCGdx" />,
            },
            {
              key: "migration",
              label: "Migration evidence",
              status: "blocked",
              statusLabel: "Blocked",
              description: "Record migration evidence before activating this profile.",
              action: <Button size="sm">Add evidence</Button>,
            },
          ]}
        />
      </WorkflowModule>,
    );

    expect(markup).toContain("Activation readiness");
    expect(markup).toContain("Review blocking checks before activation.");
    expect(markup).toContain("Blocked");
    expect(markup).toContain("Evidence");
    expect(markup).toContain("Activate");
    expect(markup).toContain("Fixture coverage");
    expect(markup).toContain("Migration evidence");
    expect(markup).toContain("Add evidence");
    expect(markup).toContain("aria-labelledby=");
    expect(markup).toContain("border-danger");
  });

  it("renders workflow action bars and empty readiness states on the server", () => {
    const markup = renderToString(
      <WorkflowModule
        title="Import operations"
        headingLevel={2}
        density="compact"
        actions={<Button size="sm">Pull provider data</Button>}
      >
        <WorkflowActionBar align="end">
          <Button size="sm" tone="secondary">
            Open override
          </Button>
        </WorkflowActionBar>
        <WorkflowReadinessChecklist items={[]} emptyState="No readiness checks" />
      </WorkflowModule>,
    );

    expect(markup).toContain("Import operations");
    expect(markup).toContain("Pull provider data");
    expect(markup).toContain("Open override");
    expect(markup).toContain("No readiness checks");
    expect(markup).toContain("p-3");
    expect(markup).toContain("sm:justify-end");
  });

  it("maps workflow module regular density alias to comfortable", () => {
    const regularAliasMarkup = renderToString(
      <WorkflowModule title="Import operations" density="regular">
        <div>Body</div>
      </WorkflowModule>,
    );
    const comfortableMarkup = renderToString(
      <WorkflowModule title="Import operations" density="comfortable">
        <div>Body</div>
      </WorkflowModule>,
    );

    expect(regularAliasMarkup).toBe(comfortableMarkup);
    expect(comfortableMarkup).toContain("p-4");
  });

  it("renders mobile product commerce as an in-flow sticky action area", () => {
    const markup = renderToString(
      <MarketplaceProductDetailLayout
        summary={<section>Product summary</section>}
        media={<section>Product media</section>}
        market={<section>Market summary</section>}
        commerce={<section>Desktop commerce panel</section>}
        mobileActionBar={<section>Mobile buy sell panel</section>}
      >
        <section>Offers list</section>
      </MarketplaceProductDetailLayout>,
    );

    expect(markup).toContain("sticky bottom-[calc(var(--shell-bottom-nav-height,0px)+env(safe-area-inset-bottom))]");
    expect(markup).not.toContain("fixed inset-x-3");
    expect(markup).not.toContain("h-32 md:hidden");
    expect(markup).toContain("xl:col-span-2");
    expect(markup).toContain("xl:sticky xl:top-20");
    expect(markup).toContain("xl:max-h-[calc(100dvh-5rem)]");
    expect(markup).toContain("xl:overflow-x-hidden");
    expect(markup).toContain("xl:[scrollbar-gutter:stable]");
    expect(markup.indexOf("Offers list")).toBeLessThan(markup.indexOf("Mobile buy sell panel"));
  });

  it("keeps --shell-bottom-nav-height symbolic in the mobile action dock after mount and a simulated breakpoint change (#5963 AC1)", () => {
    class StubResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);

    const expectedBottomClass = "bottom-[calc(var(--shell-bottom-nav-height,0px)+env(safe-area-inset-bottom))]";

    const { container } = render(
      <MarketplaceProductDetailLayout
        summary={<section>Product summary</section>}
        media={<section>Product media</section>}
        market={<section>Market summary</section>}
        commerce={<section>Desktop commerce panel</section>}
        mobileActionBar={<section>Mobile buy sell panel</section>}
      >
        <section>Offers list</section>
      </MarketplaceProductDetailLayout>,
    );

    const dock = screen.getByText("Mobile buy sell panel").closest(".sticky.z-sticky");
    expect(dock?.className).toContain(expectedBottomClass);

    // A breakpoint change resolves entirely in CSS; nothing in this component reads
    // --shell-bottom-nav-height in JS, so the class string must be byte-identical
    // after any DOM update, not just at first paint.
    fireEvent(window, new Event("resize"));

    const dockAfterResize = screen.getByText("Mobile buy sell panel").closest(".sticky.z-sticky");
    expect(dockAfterResize?.className).toContain(expectedBottomClass);
    expect(container.innerHTML).not.toContain("getComputedStyle");

    vi.unstubAllGlobals();
  });

  it("publishes the measured dock height and composes shell clearance symbolically for shell-subtree descendants (#5963 decisions 2 and 6)", () => {
    let observedCallback: ResizeObserverCallback | null = null;
    class StubResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observedCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);

    const { container } = render(
      <MarketplaceProductDetailLayout
        summary={<section>Product summary</section>}
        media={<section>Product media</section>}
        market={<section>Market summary</section>}
        commerce={<section>Desktop commerce panel</section>}
        mobileActionBar={<section>Mobile buy sell panel</section>}
      >
        <button data-focus-clearance-target>Selected listing</button>
      </MarketplaceProductDetailLayout>,
    );

    const gridRoot = container.querySelector(".grid.gap-6") as HTMLElement;
    expect(gridRoot.style.getPropertyValue("--product-detail-focus-clearance")).toBe(
      "calc(var(--product-detail-dock-height, 0px) + var(--shell-bottom-nav-height, 0px) + env(safe-area-inset-bottom))",
    );
    // Before the dock has measured itself the pattern publishes no dock-height value at
    // all, so the composed clearance stays on its declared 0px fallback instead of a
    // fabricated "0px" measurement that a reader cannot tell apart from a real one.
    expect(gridRoot.style.getPropertyValue("--product-detail-dock-height")).toBe("");

    act(() => {
      observedCallback?.(
        [{ borderBoxSize: [{ blockSize: 66 }], contentRect: { height: 66 } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    expect(gridRoot.style.getPropertyValue("--product-detail-dock-height")).toBe("66px");

    vi.unstubAllGlobals();
  });

  it("renders marketplace detail, seller, review, and comparison templates", () => {
    const markup = renderToString(
      <div>
        <ProductMediaModule title="Pikachu VMAX" media={[{ alt: "Front scan", label: "Front" }]} />
        <AccountProfileHeader
          name="Vaulted Collectibles"
          verified
          stats={[{ label: "Completed sales", value: "1,248" }]}
        />
        <ReviewCard author="Jordan M." rating={5} verified body="Arrived as described." />
        <ComparisonModule
          columns={["Seller A", "Seller B"]}
          rows={[{ label: "Total price", values: ["$120", "$124"] }]}
        />
      </div>,
    );

    expect(markup).toContain("Pikachu VMAX media");
    expect(markup).toContain("Vaulted Collectibles");
    expect(markup).toContain("Verified purchase");
    expect(markup).toContain("Total price");
  });

  it("renders marketplace recovery, status, messaging, offer, and page templates", () => {
    const markup = renderToString(
      <div>
        <MarketplaceEmptyState
          title="No exact matches"
          description="Widen filters or save the search."
          recommendationActions={<a href="/search">Remove PSA 10</a>}
        />
        <MarketplaceStatusTimeline
          steps={[
            { label: "Order confirmed", status: "complete" },
            { label: "Delivery in progress", status: "current" },
          ]}
        />
        <MessageThreadPreview
          sellerName="Vaulted Collectibles"
          title="Message Vaulted Collectibles"
          messages={[{ author: "Buyer", body: "Can you ship tomorrow?" }]}
        />
        <OfferCard title="Offer pending" amount="$1,180.00" />
        <MarketplaceTemplateGallery
          templates={[
            {
              name: "Checkout",
              purpose: "Remove surprise costs.",
              criticalSignals: ["Final total", "Secure payment"],
              primaryAction: "Confirm payment",
            },
          ]}
        />
      </div>,
    );

    expect(markup).toContain("No exact matches");
    expect(markup).toContain("Order confirmed");
    expect(markup).toContain("Vaulted Collectibles");
    expect(markup).toContain("Offer pending");
    expect(markup).toContain("Confirm payment");
  });

  it("renders tables with headers and rows", () => {
    const markup = renderToString(<Table caption="Pokemon" columns={["Name"]} rows={[["Pikachu"]]} />);

    expect(markup).toContain("Name");
    expect(markup).toContain("Pikachu");
    expect(markup).toContain("Pokemon");
  });

  it("renders navigation headers with active links", () => {
    const markup = renderToString(
      <NavigationHeader
        sticky={false}
        brand="Chase Sets"
        badge="Seller tools"
        description="Marketplace operations"
        items={[
          { href: "/admin", label: "Admin", active: true },
          { href: "/marketplace", label: "Marketplace" },
        ]}
      />,
    );

    expect(markup).toContain("Chase Sets");
    expect(markup).toContain("Seller tools");
    expect(markup).toContain('aria-current="page"');
  });

  it("keeps every bottom navigation item reachable", () => {
    render(
      <BottomNav
        activeKey="catalog-items"
        items={[
          { key: "dimensions", label: "Dimensions", href: "/dimensions" },
          { key: "fields", label: "Fields", href: "/fields" },
          { key: "components", label: "Components", href: "/components" },
          { key: "blueprints", label: "Blueprints", href: "/blueprints" },
          { key: "categories", label: "Categories", href: "/categories" },
          { key: "catalog-items", label: "Catalog Items", href: "/catalog-items" },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "Catalog Items" })).toBeTruthy();
  });

  it("renders expandable nested groups in the desktop side nav and highlights the active branch", async () => {
    render(
      <SideNav
        aria-label="Admin navigation"
        activeKey="import-review"
        items={[
          { key: "overview", label: "Overview", href: "/admin", icon: "home" },
          {
            key: "catalog-integrations",
            label: "Catalog Integrations",
            icon: "refreshCcw",
            children: [
              { key: "sources", label: "Sources", href: "/admin/catalog/sources" },
              {
                key: "imports",
                label: "Imports",
                children: [
                  { key: "import-review", label: "Import review", href: "/admin/catalog/imports/review" },
                  { key: "import-history", label: "Import history", href: "/admin/catalog/imports/history" },
                ],
              },
            ],
          },
        ]}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Admin navigation" });

    const parentToggle = within(nav).getByRole("button", { name: "Catalog Integrations" });
    const nestedToggle = within(nav).getByRole("button", { name: "Imports" });

    // The branch that owns the active route auto-expands at every level.
    expect(parentToggle.getAttribute("aria-expanded")).toBe("true");
    expect(nestedToggle.getAttribute("aria-expanded")).toBe("true");

    // Disclosure semantics: each toggle controls a labelled region.
    const parentRegionId = parentToggle.getAttribute("aria-controls");
    const parentRegion = document.getElementById(parentRegionId ?? "");
    expect(parentRegion?.getAttribute("role")).toBe("group");
    expect(parentRegion?.getAttribute("aria-label")).toBe("Catalog Integrations");

    // Active child and every ancestor toggle highlight together.
    const activeChild = within(nav).getByRole("link", { name: "Import review" });
    expect(activeChild.getAttribute("aria-current")).toBe("page");
    expect(parentToggle.className).toContain("text-accent");
    expect(nestedToggle.className).toContain("text-accent");

    // Sibling leaves stay reachable without the page marker.
    const sibling = within(nav).getByRole("link", { name: "Import history" });
    expect(sibling.getAttribute("aria-current")).toBeNull();
  });

  it("toggles side nav branches with pointer and keyboard while keeping focus", async () => {
    const user = userEvent.setup();

    render(
      <SideNav
        aria-label="Admin navigation"
        activeKey="overview"
        items={[
          { key: "overview", label: "Overview", href: "/admin", icon: "home" },
          {
            key: "catalog-integrations",
            label: "Catalog Integrations",
            icon: "refreshCcw",
            children: [{ key: "sources", label: "Sources", href: "/admin/catalog/sources" }],
          },
        ]}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Catalog Integrations" });

    // Collapsed by default when no descendant is active; children are hidden.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Sources" })).toBeNull();

    // Keyboard focus order reaches the toggle, and Enter expands it.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Overview" }));
    await user.tab();
    expect(document.activeElement).toBe(toggle);

    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Sources" })).toBeTruthy();
    expect(document.activeElement).toBe(toggle);

    // Space collapses the branch again.
    await user.keyboard("[Space]");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Sources" })).toBeNull();
  });

  it("keeps nested children reachable through the mobile bottom nav overflow", async () => {
    const user = userEvent.setup();

    render(
      <BottomNav
        activeKey="import-review"
        items={[
          { key: "overview", label: "Overview", href: "/admin", icon: "home" },
          {
            key: "catalog",
            label: "Catalog",
            icon: "refreshCcw",
            children: [
              {
                key: "imports",
                label: "Imports",
                children: [{ key: "import-review", label: "Import review", href: "/admin/catalog/imports/review" }],
              },
            ],
          },
        ]}
      />,
    );

    // The grouped bottom-nav entry opens an overflow dropdown on demand.
    const summary = screen.getByText("Catalog").closest("summary");
    expect(summary).toBeTruthy();
    await user.click(summary!);

    // Nested grandchildren stay reachable: the active branch auto-expands inside the dropdown.
    const nestedToggle = screen.getByRole("button", { name: "Imports" });
    expect(nestedToggle.getAttribute("aria-expanded")).toBe("true");

    const activeChild = screen.getByRole("link", { name: "Import review" });
    expect(activeChild.getAttribute("aria-current")).toBe("page");
    expect(activeChild.getAttribute("href")).toBe("/admin/catalog/imports/review");
  });

  it("collapses top navigation actions into an admin menu for mobile", async () => {
    const user = userEvent.setup();

    render(
      <TopNav
        brand={<div>Catalog Ops</div>}
        items={[]}
        mobileActionsLabel="Admin menu"
        actions={
          <>
            <a href="/growth/waitlist">Growth</a>
            <a href="/access/accounts">Access</a>
            <form action="/catalog/sign-out" method="post">
              <button type="submit">Sign Out</button>
            </form>
          </>
        }
      />,
    );

    const trigger = screen.getByLabelText("Admin menu");
    const details = trigger.closest("details");
    expect(details?.className).toContain("md:hidden");
    expect(details?.open).toBe(false);

    await user.click(trigger);

    expect(details?.open).toBe(true);
    const menu = details?.querySelector(".modern-surface");
    expect(menu).toBeTruthy();
    expect(
      within(menu as HTMLElement)
        .getByRole("link", { name: "Growth" })
        .getAttribute("href"),
    ).toBe("/growth/waitlist");
    expect(
      within(menu as HTMLElement)
        .getByRole("link", { name: "Access" })
        .getAttribute("href"),
    ).toBe("/access/accounts");
    expect(
      within(menu as HTMLElement)
        .getByRole("button", { name: "Sign Out" })
        .getAttribute("type"),
    ).toBe("submit");
  });

  it("keeps top navigation actions inline unless a mobile actions label is provided", () => {
    render(<TopNav brand={<div>Chase Sets</div>} items={[]} actions={<a href="/sign-in">Sign In</a>} />);

    expect(screen.queryByLabelText("Admin menu")).toBeNull();
    expect(screen.getByRole("link", { name: "Sign In" }).getAttribute("href")).toBe("/sign-in");
  });

  it("closes top navigation child menus with Escape", async () => {
    const user = userEvent.setup();

    render(
      <div>
        <TopNav
          items={[
            {
              key: "selling-workspace",
              label: "Sell",
              children: [
                { key: "listings", label: "Listings", href: "/account/listings" },
                { key: "offer-matches", label: "Offer Matches", href: "/account/offers/matches" },
              ],
            },
          ]}
        />
        <button type="button">Outside</button>
      </div>,
    );

    const sellTrigger = screen.getByRole("button", { name: "Sell" });
    expect(screen.queryByRole("link", { name: "Listings" })).toBeNull();

    await user.click(sellTrigger);
    expect(await screen.findByRole("link", { name: "Listings" })).toBeTruthy();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("link", { name: "Listings" })).toBeNull());
  });

  it("keeps top navigation child links as reachable portal menu links", async () => {
    const user = userEvent.setup();

    render(
      <ChaseRoot>
        <TopNav
          items={[
            {
              key: "selling-workspace",
              label: "Sell",
              children: [
                { key: "inventory", label: "Inventory", href: "/account/inventory" },
                { key: "inventory-imports", label: "Import", href: "/account/inventory/imports" },
                { key: "listings", label: "Listings", href: "/account/listings" },
              ],
            },
          ]}
        />
      </ChaseRoot>,
    );

    await user.click(screen.getByRole("button", { name: "Sell" }));

    const importLink = await screen.findByRole("link", { name: "Import" });
    const click = vi.fn((event: globalThis.MouseEvent) => {
      expect(event.defaultPrevented).toBe(false);
      event.preventDefault();
    });

    expect(importLink.closest("[data-chase-overlay-root]")).toBeTruthy();
    expect(importLink.getAttribute("href")).toBe("/account/inventory/imports");

    importLink.addEventListener("click", click);
    await user.click(importLink);

    expect(click).toHaveBeenCalledTimes(1);
  });

  it("syncs theme toggle choices to the document theme", async () => {
    const user = userEvent.setup();
    const storage = new Map<string, string>();

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-preference");

    render(<ThemeToggle />);

    await waitFor(() => {
      expect(document.documentElement.dataset.themePreference).toBe("system");
    });

    await user.click(screen.getByRole("radio", { name: "Dark" }));

    expect(storage.get("chase-sets-theme")).toBe("dark");
    await waitFor(() => {
      expect(document.documentElement.dataset.themePreference).toBe("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
    });
  });

  it("renders tabs and panels", () => {
    render(
      <Tabs
        items={[
          { value: "summary", label: "Summary", content: <div>Summary content</div> },
          { value: "activity", label: "Activity", content: <div>Activity content</div> },
        ]}
      />,
    );

    expect(screen.getByRole("tab", { name: "Summary" })).toBeTruthy();
    expect(screen.getByText("Summary content")).toBeTruthy();
  });

  it("scrollable-row Tabs keep the active tab visible without page overflow", () => {
    const defaultMarkup = renderToString(
      <Tabs
        items={[
          { value: "listings", label: "Listings", content: <div>Listings content</div> },
          { value: "offers", label: "Offers", content: <div>Offers content</div> },
        ]}
      />,
    );
    const scrollableMarkup = renderToString(
      <Tabs
        mobileLayout="scrollable-row"
        items={[
          { value: "listings", label: "Listings", content: <div>Listings content</div> },
          { value: "offers", label: "Offers", content: <div>Offers content</div> },
          { value: "sales", label: "Sales", content: <div>Sales content</div> },
          { value: "details", label: "Details", content: <div>Details content</div> },
        ]}
      />,
    );

    expect(defaultMarkup).toContain(
      "grid w-full min-w-0 max-w-full grid-cols-2 gap-2 rounded-tokenLg border border-muted bg-background p-2 md:inline-flex md:flex-wrap",
    );
    expect(defaultMarkup).not.toContain("data-mobile-layout");
    expect(scrollableMarkup).toContain('data-mobile-layout="scrollable-row"');
    expect(scrollableMarkup).toContain("flex-nowrap");
    expect(scrollableMarkup).toContain("overflow-x-auto");
    expect(scrollableMarkup).toContain("md:overflow-visible");
  });

  it("scrollable-row Tabs preserve keyboard and panel semantics", async () => {
    const user = userEvent.setup();
    render(
      <Tabs
        mobileLayout="scrollable-row"
        items={[
          { value: "listings", label: "Listings", content: <div>Listings content</div> },
          { value: "offers", label: "Offers", content: <div>Offers content</div> },
          { value: "sales", label: "Sales", content: <div>Sales content</div> },
          { value: "details", label: "Details", content: <div>Details content</div> },
        ]}
      />,
    );

    const listings = screen.getByRole("tab", { name: "Listings" });
    await act(async () => {
      listings.focus();
      fireEvent.keyDown(listings, { key: "ArrowRight" });
    });

    const offers = screen.getByRole("tab", { name: "Offers" });
    await waitFor(() => expect(document.activeElement).toBe(offers));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(offers.getAttribute("aria-selected")).toBe("true"));
    expect(within(screen.getByRole("tabpanel", { name: "Offers" })).getByText("Offers content")).toBeTruthy();
    expect(screen.queryByRole("tabpanel", { name: "Listings" })).toBeNull();
  });

  it("controlled scrollable-row Tabs reveal the selected tab", async () => {
    function ControlledTabs() {
      const [value, setValue] = useState("listings");

      return (
        <>
          <button type="button" onClick={() => setValue("details")}>
            Show details
          </button>
          <Tabs
            mobileLayout="scrollable-row"
            value={value}
            onValueChange={setValue}
            items={[
              { value: "listings", label: "Listings", content: <div>Listings content</div> },
              { value: "offers", label: "Offers", content: <div>Offers content</div> },
              { value: "sales", label: "Sales", content: <div>Sales content</div> },
              { value: "details", label: "Details", content: <div>Details content</div> },
            ]}
          />
        </>
      );
    }

    render(<ControlledTabs />);

    const bounds = (left: number, right: number) =>
      ({
        x: left,
        y: 0,
        left,
        right,
        top: 0,
        bottom: 40,
        width: right - left,
        height: 40,
        toJSON: () => ({}),
      }) as DOMRect;
    const tabList = screen.getByRole("tablist");
    const details = screen.getByRole("tab", { name: "Details" });
    const scrollBy = vi.fn();
    Object.defineProperty(tabList, "getBoundingClientRect", { configurable: true, value: () => bounds(0, 200) });
    Object.defineProperty(details, "getBoundingClientRect", { configurable: true, value: () => bounds(220, 300) });
    Object.defineProperty(tabList, "scrollBy", { configurable: true, value: scrollBy });

    fireEvent.click(screen.getByRole("button", { name: "Show details" }));

    await waitFor(() => expect(scrollBy).toHaveBeenCalledWith({ left: 100, behavior: "smooth" }));
    expect(details.getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("tabpanel", { name: "Details" })).getByText("Details content")).toBeTruthy();
  });

  it("keeps the selected action tab and exposed panel synchronized", () => {
    function ControlledTabs() {
      const [value, setValue] = useState("offers");

      return (
        <>
          <button type="button" onClick={() => setValue("listings")}>
            Show listings
          </button>
          <Tabs
            value={value}
            onValueChange={setValue}
            items={[
              { value: "listings", label: "Listings", content: <div>Listings content</div> },
              { value: "offers", label: "Offers", content: <div>Offers content</div> },
            ]}
          />
        </>
      );
    }

    render(<ControlledTabs />);

    expect(screen.getByRole("tab", { name: "Offers" }).getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("tabpanel", { name: "Offers" })).getByText("Offers content")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show listings" }));

    expect(screen.getByRole("tab", { name: "Listings" }).getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("tabpanel", { name: "Listings" })).getByText("Listings content")).toBeTruthy();
    expect(screen.queryByRole("tabpanel", { name: "Offers" })).toBeNull();
  });

  it("renders action tabs with a scroll-stable panel frame", () => {
    const markup = renderToString(
      <Tabs
        items={[
          { value: "listings", label: "Listings", content: <div>Listings content</div> },
          { value: "offers", label: "Offers", content: <div>Offers content</div> },
        ]}
      />,
    );

    expect(markup).toContain("[overflow-anchor:none]");
  });

  it("wires action tab direction through to Base UI", () => {
    const markup = renderToString(
      <Tabs
        dir="rtl"
        items={[
          { value: "listings", label: "Listings", content: <div>Listings content</div> },
          { value: "offers", label: "Offers", content: <div>Offers content</div> },
        ]}
      />,
    );

    expect(markup).toContain('dir="rtl"');
  });

  it("opens dialogs from triggers", async () => {
    const user = userEvent.setup();

    render(
      <Dialog
        trigger={<Button>Open review</Button>}
        title="Review listing"
        description="Check pricing before publishing."
      >
        Dialog content
      </Dialog>,
    );

    await user.click(screen.getByRole("button", { name: "Open review" }));

    expect(await screen.findByRole("dialog", { name: "Review listing" })).toBeTruthy();
    expect(screen.getByText("Dialog content")).toBeTruthy();
  });

  it("renders reference info triggers and structured dialogs", async () => {
    const user = userEvent.setup();
    const onOpenReference = vi.fn((event: MouseEvent<HTMLAnchorElement>) => event.preventDefault());

    const triggerRender = render(
      <div>
        <ReferenceInfoTrigger
          href="/catalog/reference-records/ref_pokemon"
          aria-label="View Manufacturer reference details for The Pokemon Company International"
          onClick={onOpenReference}
        >
          The Pokemon Company International
        </ReferenceInfoTrigger>
        <ReferenceInfoTrigger aria-label="View estimated payout details">Estimated payout</ReferenceInfoTrigger>
      </div>,
    );

    const referenceLink = screen.getByRole("link", {
      name: "View Manufacturer reference details for The Pokemon Company International",
    });
    const payoutTrigger = screen.getByRole("button", { name: "View estimated payout details" });

    expect(referenceLink.getAttribute("href")).toBe("/catalog/reference-records/ref_pokemon");
    expect(referenceLink.getAttribute("aria-haspopup")).toBe("dialog");
    expect(referenceLink.className).toContain("text-accent");
    expect(payoutTrigger.getAttribute("aria-haspopup")).toBe("dialog");

    await user.click(referenceLink);
    expect(onOpenReference).toHaveBeenCalledTimes(1);

    triggerRender.unmount();

    render(
      <ReferenceInfoDialog
        trigger={
          <ReferenceInfoTrigger aria-label="View estimated payout details">Estimated payout</ReferenceInfoTrigger>
        }
        title="Estimated payout"
        description="Current standard seller terms"
        closeLabel="Close payout details"
        summary="Estimated payout uses current standard seller terms."
        sections={[
          {
            items: [
              { key: "Offer total", value: "$80.00" },
              { key: "Marketplace fee", value: "$7.20" },
            ],
          },
          {
            title: "Final review",
            emptyState: "Final registered terms are confirmed before acceptance.",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "View estimated payout details" }));

    const dialog = await screen.findByRole("dialog", { name: "Estimated payout" });
    expect(within(dialog).getByText("Current standard seller terms")).toBeTruthy();
    expect(within(dialog).getByText("Estimated payout uses current standard seller terms.")).toBeTruthy();
    expect(within(dialog).getByText("Offer total")).toBeTruthy();
    expect(within(dialog).getByText("$80.00")).toBeTruthy();
    expect(within(dialog).getByText("Final registered terms are confirmed before acceptance.")).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Close payout details" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Estimated payout" })).toBeNull());
  });
});

describe("marketplace shell search-row collapse (#5709)", () => {
  const itemIdentity = "/items/charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp";

  // Frozen goldens captured from MarketplaceShell and TopNav at exact main
  // a1658e3461016b10da2930160fec6aa60caa55b7 rendering the identical fixture
  // props below; criterion 14 compares omitting callers against these bytes,
  // never against themselves.
  const exactMainShellGolden = "<div class=\"min-h-screen bg-background [--shell-header-height:7.75rem] md:[--shell-header-height:4rem] [--shell-bottom-nav-height:5.25rem] md:[--shell-bottom-nav-height:0px]\"><a href=\"#main-content\" class=\"sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-toast focus:rounded-tokenMd focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent-contrast focus:shadow-overlay\">Skip to main content</a><nav aria-label=\"Primary navigation\" class=\"sticky top-0 z-sticky border-b border-muted bg-background/overlay px-4 py-3 shadow-tokenSm backdrop-blur-xl\"><div class=\"w-full px-0\"><div class=\"mx-auto w-full max-w-none\"><div class=\"flex w-full flex-wrap items-center justify-between gap-4\"><div class=\"flex items-center gap-4\"><a href=\"/\">Chase Sets</a><div class=\"hidden md:flex\"><div class=\"flex items-center gap-1\"><a href=\"/search\" class=\"focus-ring relative inline-flex items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-medium transition min-h-[var(--control-md-height)] text-secondary hover:bg-surface-2 hover:text-foreground\"><span class=\"relative z-10 inline-flex items-center gap-2\"><span class=\"\">Browse</span></span></a></div></div></div><div class=\"order-3 w-full md:order-none md:min-w-64 md:max-w-xl md:flex-1\"><input aria-label=\"Marketplace search fixture\"></div><div class=\"flex items-center gap-2\"><a href=\"/sign-in\">Sign In</a><div class=\"hidden md:flex\"><div class=\"flex items-center gap-1\"><a href=\"/account/cart\" class=\"focus-ring relative inline-flex items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-medium transition min-h-[var(--control-md-height)] text-secondary hover:bg-surface-2 hover:text-foreground\"><span class=\"relative z-10 inline-flex items-center gap-2\"><span class=\"\">Buy Cart</span></span></a></div></div></div></div></div></div></nav><main id=\"main-content\" tabindex=\"-1\" class=\"relative z-0\"><div class=\"mx-auto flex w-full min-w-0 max-w-full flex-col gap-6 overflow-x-clip px-4 py-6 pb-24 md:px-6 md:pb-8 max-w-none\"><div class=\"space-y-6\"><div><button type=\"button\">First content action</button></div></div></div></main><nav class=\"fixed inset-x-0 bottom-0 z-sticky border-t border-muted bg-background/overlay px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-tokenLg backdrop-blur-xl md:hidden\"><div class=\"mx-auto grid w-full gap-2 grid-cols-2 max-w-none\"><a href=\"/search\" class=\"focus-ring relative inline-flex w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-tokenMd px-1 py-3 text-sm font-medium transition text-secondary hover:bg-surface-2 hover:text-foreground\"><span class=\"relative z-10 inline-flex items-center gap-2 w-full min-w-0 flex-col justify-center\"><span class=\"relative inline-flex h-5 w-5 items-center justify-center\"></span><span class=\"max-w-full text-center text-2xs leading-tight [overflow-wrap:anywhere]\">Browse</span></span></a><a href=\"/account/cart\" class=\"focus-ring relative inline-flex w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-tokenMd px-1 py-3 text-sm font-medium transition text-secondary hover:bg-surface-2 hover:text-foreground\"><span class=\"relative z-10 inline-flex items-center gap-2 w-full min-w-0 flex-col justify-center\"><span class=\"relative inline-flex h-5 w-5 items-center justify-center\"></span><span class=\"max-w-full text-center text-2xs leading-tight [overflow-wrap:anywhere]\">Buy Cart</span></span></a></div></nav></div>";
  const exactMainTopNavGolden = "<nav aria-label=\"Primary navigation\" class=\"sticky top-0 z-sticky border-b border-muted bg-background/overlay px-4 py-3 shadow-tokenSm backdrop-blur-xl\"><div class=\"w-full px-0\"><div class=\"mx-auto w-full max-w-none\"><div class=\"flex w-full flex-wrap items-center justify-between gap-4\"><div class=\"flex items-center gap-4\"><a href=\"/\">Chase Sets</a><div class=\"hidden md:flex\"><div class=\"flex items-center gap-1\"><a href=\"/search\" class=\"focus-ring relative inline-flex items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-medium transition min-h-[var(--control-md-height)] text-secondary hover:bg-surface-2 hover:text-foreground\"><span class=\"relative z-10 inline-flex items-center gap-2\"><span class=\"\">Browse</span></span></a></div></div></div><div class=\"order-3 w-full md:order-none md:min-w-64 md:max-w-xl md:flex-1\"><input aria-label=\"Marketplace search fixture\"></div><div class=\"flex items-center gap-2\"></div></div></div></div></nav>";

  const collapsedOverrideClass = "data-[search-row-state=collapsed]:[--shell-header-height:4rem]";

  function setWindowMetric(name: "innerWidth" | "innerHeight" | "scrollY", value: number) {
    Object.defineProperty(window, name, { configurable: true, writable: true, value });
  }

  function usePhoneViewport() {
    setWindowMetric("innerWidth", 390);
    setWindowMetric("innerHeight", 844);
    setWindowMetric("scrollY", 0);
  }

  function driveScroll(to: number) {
    setWindowMetric("scrollY", to);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
  }

  function driveResize(width: number) {
    setWindowMetric("innerWidth", width);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  function shellFixture(props: { collapseSearchOnScroll?: boolean; routeIdentity?: string; children?: ReactNode }) {
    return (
      <MarketplaceShell
        brand={<a href="/">Chase Sets</a>}
        topNavItems={[
          { key: "browse", label: "Browse", href: "/search" },
          { key: "cart", label: "Buy Cart", href: "/account/cart", placement: "utility" },
        ]}
        bottomNavItems={[
          { key: "browse", label: "Browse", href: "/search" },
          { key: "cart", label: "Buy Cart", href: "/account/cart" },
        ]}
        search={<input aria-label="Marketplace search fixture" />}
        actions={<a href="/sign-in">Sign In</a>}
        collapseSearchOnScroll={props.collapseSearchOnScroll}
        routeIdentity={props.routeIdentity}
      >
        {props.children ?? (
          <div>
            <button type="button">First content action</button>
          </div>
        )}
      </MarketplaceShell>
    );
  }

  function shellStateAttribute(container: HTMLElement) {
    const outer = container.querySelector("div.min-h-screen");
    expect(outer).not.toBeNull();
    return outer!.getAttribute("data-search-row-state");
  }

  // Resolves --shell-header-height for an element by compiling its exact class
  // list with the installed Tailwind and applying declaration/variant matching:
  // the class-plus-attribute variant strictly outranks the bare-class
  // declaration, and a variant whose attribute the element does not carry can
  // never match. Measured through the real compiler, not assumed.
  async function resolveShellHeaderHeightPx(element: Element): Promise<number> {
    const tailwind = await import("tailwindcss");
    const classes = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const compiler = await tailwind.compile("@tailwind utilities;", {
      loadStylesheet: async () => ({ content: "", base: "" }),
    });
    const css = compiler.build(classes);
    const declarations: Array<{ rem: number; requiredAttribute?: { name: string; value: string } }> = [];
    const blockPattern = /\.(?:[^{]+?)\{([\s\S]*?)\n\}/g;
    for (const block of css.matchAll(blockPattern)) {
      const body = block[1]!;
      const bare = /^\s*--shell-header-height:\s*([\d.]+)rem;\s*$/m.exec(body);
      const variant = /&\[([a-z-]+)="([^"]+)"\]\s*\{\s*--shell-header-height:\s*([\d.]+)rem;/.exec(body);
      if (variant) {
        declarations.push({
          rem: Number.parseFloat(variant[3]!),
          requiredAttribute: { name: variant[1]!, value: variant[2]! },
        });
      } else if (bare && !body.includes("&[")) {
        declarations.push({ rem: Number.parseFloat(bare[1]!) });
      }
    }
    const applicable = declarations.filter(
      (declaration) =>
        !declaration.requiredAttribute ||
        element.getAttribute(declaration.requiredAttribute.name) === declaration.requiredAttribute.value,
    );
    expect(applicable.length).toBeGreaterThan(0);
    const winner =
      applicable.find((declaration) => declaration.requiredAttribute !== undefined) ??
      applicable[applicable.length - 1]!;
    return winner.rem * 16;
  }

  it("resolves exactly one search-row phase and exactly one published row for every environment and event", () => {
    const clamp = (value: number) => Math.max(-DIRECTION_DELTA, Math.min(DIRECTION_DELTA, value));
    const armed = (environment: SearchRowEnvironment) =>
      environment.enabled && environment.hasSearch && environment.belowMd;
    const priorPhase = (state: SearchRowState) => (state.phase === "inert" ? SEED_PHASE : state.phase);
    // Independent transcription of the published stage-1 fold, used only to
    // classify cells against the published rows.
    const foldTravel = (state: SearchRowState, environment: SearchRowEnvironment) => {
      const step = state.lastScrollY - environment.scrollY;
      if (step === 0) {
        return state.travel;
      }
      if (state.travel === 0 || state.travel > 0 === step > 0) {
        return clamp(state.travel + step);
      }
      return clamp(step);
    };
    const initEvents: readonly SearchRowEventType[] = ["mount", "routechange", "viewportchange"];

    type PublishedRow = {
      readonly id: string;
      readonly matches: (type: SearchRowEventType, state: SearchRowState, environment: SearchRowEnvironment) => boolean;
      readonly steady: (
        state: SearchRowState,
        environment: SearchRowEnvironment,
      ) => { phase: SearchRowState["phase"]; travel: number };
    };

    const rows: readonly PublishedRow[] = [
      {
        id: "T1",
        matches: (type, _state, environment) => initEvents.includes(type) && !armed(environment),
        steady: () => ({ phase: "inert", travel: 0 }),
      },
      {
        id: "T2",
        matches: (type, _state, environment) =>
          initEvents.includes(type) && armed(environment) && searchRowPolicy(environment.routeIdentity) === "always-expanded",
        steady: () => ({ phase: "expanded", travel: 0 }),
      },
      {
        id: "T3",
        matches: (type, _state, environment) =>
          initEvents.includes(type) &&
          armed(environment) &&
          searchRowPolicy(environment.routeIdentity) === "collapsible" &&
          environment.focusInHeader,
        steady: () => ({ phase: "expanded", travel: 0 }),
      },
      {
        id: "T4",
        matches: (type, _state, environment) =>
          initEvents.includes(type) &&
          armed(environment) &&
          searchRowPolicy(environment.routeIdentity) === "collapsible" &&
          !environment.focusInHeader &&
          environment.scrollY < COLLAPSE_FLOOR,
        steady: () => ({ phase: "expanded", travel: 0 }),
      },
      {
        id: "T5",
        matches: (type, _state, environment) =>
          initEvents.includes(type) &&
          armed(environment) &&
          searchRowPolicy(environment.routeIdentity) === "collapsible" &&
          !environment.focusInHeader &&
          environment.scrollY >= COLLAPSE_FLOOR,
        steady: () => ({ phase: SEED_PHASE, travel: 0 }),
      },
      {
        id: "T6",
        matches: (type, _state, environment) => type === "focuschange" && !armed(environment),
        steady: () => ({ phase: "inert", travel: 0 }),
      },
      {
        id: "T7",
        matches: (type, state, environment) =>
          type === "focuschange" && armed(environment) && searchRowPolicy(state.routeIdentity) === "always-expanded",
        steady: () => ({ phase: "expanded", travel: 0 }),
      },
      {
        id: "T8",
        matches: (type, state, environment) =>
          type === "focuschange" &&
          armed(environment) &&
          searchRowPolicy(state.routeIdentity) === "collapsible" &&
          environment.focusInHeader,
        steady: () => ({ phase: "expanded", travel: 0 }),
      },
      {
        id: "T9",
        matches: (type, state, environment) =>
          type === "focuschange" &&
          armed(environment) &&
          searchRowPolicy(state.routeIdentity) === "collapsible" &&
          !environment.focusInHeader &&
          environment.scrollY < COLLAPSE_FLOOR,
        steady: () => ({ phase: "expanded", travel: 0 }),
      },
      {
        id: "T10",
        matches: (type, state, environment) =>
          type === "focuschange" &&
          armed(environment) &&
          searchRowPolicy(state.routeIdentity) === "collapsible" &&
          !environment.focusInHeader &&
          environment.scrollY >= COLLAPSE_FLOOR,
        steady: (state) => ({ phase: priorPhase(state), travel: 0 }),
      },
      {
        id: "T11",
        matches: (type, _state, environment) => type === "scroll" && !armed(environment),
        steady: () => ({ phase: "inert", travel: 0 }),
      },
      {
        id: "T12",
        matches: (type, state, environment) =>
          type === "scroll" && armed(environment) && searchRowPolicy(state.routeIdentity) === "always-expanded",
        steady: (state, environment) => ({ phase: "expanded", travel: foldTravel(state, environment) }),
      },
      {
        id: "T13",
        matches: (type, state, environment) =>
          type === "scroll" &&
          armed(environment) &&
          searchRowPolicy(state.routeIdentity) === "collapsible" &&
          environment.focusInHeader,
        steady: (state, environment) => ({ phase: "expanded", travel: foldTravel(state, environment) }),
      },
      {
        id: "T14",
        matches: (type, state, environment) =>
          type === "scroll" &&
          armed(environment) &&
          searchRowPolicy(state.routeIdentity) === "collapsible" &&
          !environment.focusInHeader &&
          environment.scrollY < COLLAPSE_FLOOR,
        steady: (state, environment) => ({ phase: "expanded", travel: foldTravel(state, environment) }),
      },
      {
        id: "T15",
        matches: (type, state, environment) =>
          type === "scroll" &&
          armed(environment) &&
          searchRowPolicy(state.routeIdentity) === "collapsible" &&
          !environment.focusInHeader &&
          environment.scrollY >= COLLAPSE_FLOOR &&
          foldTravel(state, environment) >= DIRECTION_DELTA,
        steady: () => ({ phase: "expanded", travel: 0 }),
      },
      {
        id: "T16",
        matches: (type, state, environment) =>
          type === "scroll" &&
          armed(environment) &&
          searchRowPolicy(state.routeIdentity) === "collapsible" &&
          !environment.focusInHeader &&
          environment.scrollY >= COLLAPSE_FLOOR &&
          foldTravel(state, environment) <= -DIRECTION_DELTA,
        steady: () => ({ phase: "collapsed", travel: 0 }),
      },
      {
        id: "T17",
        matches: (type, state, environment) =>
          type === "scroll" &&
          armed(environment) &&
          searchRowPolicy(state.routeIdentity) === "collapsible" &&
          !environment.focusInHeader &&
          environment.scrollY >= COLLAPSE_FLOOR &&
          foldTravel(state, environment) > -DIRECTION_DELTA &&
          foldTravel(state, environment) < DIRECTION_DELTA,
        steady: (state, environment) => ({ phase: priorPhase(state), travel: foldTravel(state, environment) }),
      },
    ];

    const environments: SearchRowEnvironment[] = [];
    for (const enabled of [true, false]) {
      for (const hasSearch of [true, false]) {
        for (const belowMd of [true, false]) {
          for (const focusInHeader of [true, false]) {
            for (const routeIdentity of ["/search", itemIdentity]) {
              for (const scrollY of [0, 95, 96, 2000]) {
                environments.push({ enabled, hasSearch, belowMd, focusInHeader, routeIdentity, scrollY });
              }
            }
          }
        }
      }
    }

    const rowHits: Record<string, number> = Object.fromEntries(rows.map((row) => [row.id, 0]));
    let cellCount = 0;
    let unmatchedCells = 0;
    let multiplyMatchedCells = 0;
    let steadyStateMismatches = 0;
    let armedInertViolations = 0;
    let aboveMdNonInertViolations = 0;
    let determinismMismatches = 0;

    for (const environment of environments) {
      for (const phase of ["inert", "expanded", "collapsed"] as const) {
        for (const travel of [-23, 0, 23]) {
          for (const lastScrollYOffset of [-30, -1, 0, 1, 30]) {
            for (const stateRouteIdentity of ["/search", itemIdentity]) {
              const state: SearchRowState = {
                phase,
                travel,
                lastScrollY: environment.scrollY + lastScrollYOffset,
                routeIdentity: stateRouteIdentity,
              };
              for (const type of SEARCH_ROW_EVENT_TYPES) {
                cellCount += 1;
                const event: SearchRowEvent = { type, environment };
                const result = searchRowReducer(state, event);
                const again = searchRowReducer(state, event);
                if (JSON.stringify(result) !== JSON.stringify(again)) {
                  determinismMismatches += 1;
                }
                if (armed(environment) && result.phase === "inert") {
                  armedInertViolations += 1;
                }
                if (!environment.belowMd && result.phase !== "inert") {
                  aboveMdNonInertViolations += 1;
                }
                const matching = rows.filter((row) => row.matches(type, state, environment));
                if (matching.length === 0) {
                  unmatchedCells += 1;
                  continue;
                }
                if (matching.length > 1) {
                  multiplyMatchedCells += 1;
                  continue;
                }
                const row = matching[0]!;
                rowHits[row.id] += 1;
                const steady = row.steady(state, environment);
                const expectedRouteIdentity = initEvents.includes(type)
                  ? environment.routeIdentity
                  : state.routeIdentity;
                if (
                  result.phase !== steady.phase ||
                  result.travel !== steady.travel ||
                  result.lastScrollY !== environment.scrollY ||
                  result.routeIdentity !== expectedRouteIdentity
                ) {
                  steadyStateMismatches += 1;
                }
              }
            }
          }
        }
      }
    }

    const counters = {
      cellCount,
      unmatchedCells,
      multiplyMatchedCells,
      steadyStateMismatches,
      armedInertViolations,
      aboveMdNonInertViolations,
      determinismMismatches,
      unreachableRows: rows.filter((row) => rowHits[row.id] === 0).map((row) => row.id),
      alphabetSize: SEARCH_ROW_EVENT_TYPES.length,
    };
    expect(counters).toEqual({
      cellCount: 57600,
      unmatchedCells: 0,
      multiplyMatchedCells: 0,
      steadyStateMismatches: 0,
      armedInertViolations: 0,
      aboveMdNonInertViolations: 0,
      determinismMismatches: 0,
      unreachableRows: [],
      alphabetSize: 5,
    });
    expect([...SEARCH_ROW_EVENT_TYPES].sort()).toEqual([
      "focuschange",
      "mount",
      "routechange",
      "scroll",
      "viewportchange",
    ]);
    expect(rowHits).toEqual({
      T1: 30240,
      T2: 2160,
      T3: 1080,
      T4: 540,
      T5: 540,
      T6: 10080,
      T7: 720,
      T8: 360,
      T9: 180,
      T10: 180,
      T11: 10080,
      T12: 720,
      T13: 360,
      T14: 180,
      T15: 48,
      T16: 48,
      T17: 84,
    });
  });

  it("initializes the search row from the observed scroll offset and route policy", () => {
    usePhoneViewport();
    setWindowMetric("scrollY", 2000);
    const restored = render(shellFixture({ collapseSearchOnScroll: true, routeIdentity: itemIdentity }));
    expect(shellStateAttribute(restored.container)).toBe("collapsed");
    restored.unmount();

    setWindowMetric("scrollY", 0);
    const top = render(shellFixture({ collapseSearchOnScroll: true, routeIdentity: itemIdentity }));
    expect(shellStateAttribute(top.container)).toBe("expanded");
    top.unmount();

    setWindowMetric("scrollY", 2000);
    const unarmed = render(shellFixture({ routeIdentity: itemIdentity }));
    expect(shellStateAttribute(unarmed.container)).toBeNull();
    unarmed.unmount();

    const searchRoute = render(shellFixture({ collapseSearchOnScroll: true, routeIdentity: "/search" }));
    expect(shellStateAttribute(searchRoute.container)).toBe("expanded");
    searchRoute.unmount();
  });

  it("re-initializes the search row on route change and on returning below md", () => {
    usePhoneViewport();
    setWindowMetric("scrollY", 2000);
    const observations: SearchRowObservation[] = [];
    const stopObserving = observeSearchRowEvents((observation) => observations.push(observation));
    try {
      const view = render(shellFixture({ collapseSearchOnScroll: true, routeIdentity: itemIdentity }));
      expect(shellStateAttribute(view.container)).toBe("collapsed");

      // Route change from an expanded prior phase at scrollY 2000 -> collapsed.
      driveScroll(1976);
      expect(shellStateAttribute(view.container)).toBe("expanded");
      view.rerender(shellFixture({ collapseSearchOnScroll: true, routeIdentity: "/items/another-item" }));
      expect(observations.at(-1)!.event.type).toBe("routechange");
      expect(shellStateAttribute(view.container)).toBe("collapsed");

      // Route change from a collapsed prior phase at scrollY 0 -> expanded.
      setWindowMetric("scrollY", 0);
      view.rerender(shellFixture({ collapseSearchOnScroll: true, routeIdentity: itemIdentity }));
      expect(observations.at(-1)!.event.type).toBe("routechange");
      expect(shellStateAttribute(view.container)).toBe("expanded");

      // Crossing to md and back below md re-initializes identically to mount,
      // from an expanded prior phase.
      setWindowMetric("scrollY", 2000);
      driveResize(800);
      expect(shellStateAttribute(view.container)).toBeNull();
      driveResize(390);
      expect(observations.at(-1)!.event.type).toBe("viewportchange");
      expect(shellStateAttribute(view.container)).toBe("collapsed");

      // And from a collapsed prior phase at scrollY 0 -> expanded.
      driveResize(800);
      setWindowMetric("scrollY", 0);
      driveResize(390);
      expect(shellStateAttribute(view.container)).toBe("expanded");

      // A re-render that changes neither the pathname identity nor the viewport
      // emits no event at all and disturbs no state: re-seed at scrollY 2000,
      // drive some accumulated travel, re-render with identical identity and
      // different children, and prove the accumulator and lastScrollY survive.
      setWindowMetric("scrollY", 2000);
      view.rerender(
        shellFixture({ collapseSearchOnScroll: true, routeIdentity: "/items/another-item", children: <div>a</div> }),
      );
      expect(observations.at(-1)!.event.type).toBe("routechange");
      expect(shellStateAttribute(view.container)).toBe("collapsed");
      driveScroll(1976);
      expect(shellStateAttribute(view.container)).toBe("expanded");
      driveScroll(1986);
      expect(shellStateAttribute(view.container)).toBe("expanded");
      const observationCountBefore = observations.length;
      const lastObservationBefore = observations.at(-1)!;
      expect(lastObservationBefore.state.travel).toBe(-10);
      expect(lastObservationBefore.state.lastScrollY).toBe(1986);
      view.rerender(
        shellFixture({ collapseSearchOnScroll: true, routeIdentity: "/items/another-item", children: <div>b</div> }),
      );
      expect(observations.length).toBe(observationCountBefore);
      expect(observations.filter((observation) => observation.event.type === "routechange").length).toBe(3);
      // 14 more px of downward travel completes the retained accumulator.
      driveScroll(2000);
      expect(shellStateAttribute(view.container)).toBe("collapsed");
      expect(observations.at(-1)!.state.travel).toBe(0);
      view.unmount();
    } finally {
      stopObserving();
    }
  });

  it("holds the search-row hysteresis boundaries including the 23 down 1 up 2 down reversal", () => {
    const environment = (scrollY: number): SearchRowEnvironment => ({
      enabled: true,
      hasSearch: true,
      belowMd: true,
      scrollY,
      focusInHeader: false,
      routeIdentity: itemIdentity,
    });
    const scroll = (state: SearchRowState, scrollY: number) =>
      searchRowReducer(state, { type: "scroll", environment: environment(scrollY) });
    const expanded: SearchRowState = { phase: "expanded", travel: 0, lastScrollY: 1000, routeIdentity: itemIdentity };
    const collapsed: SearchRowState = { ...expanded, phase: "collapsed" };

    // At scrollY 95 the row is expanded regardless of downward travel.
    expect(scroll({ ...expanded, lastScrollY: 0 }, 95).phase).toBe("expanded");
    expect(scroll({ ...collapsed, lastScrollY: 0 }, 95).phase).toBe("expanded");

    // 23px of downward travel past the floor does not collapse; 24px does.
    const down23 = scroll(expanded, 1023);
    expect(down23.phase).toBe("expanded");
    expect(down23.travel).toBe(-23);
    const down24 = scroll(expanded, 1024);
    expect(down24.phase).toBe("collapsed");
    expect(down24.travel).toBe(0);

    // 23px of upward travel does not reveal; 24px does.
    const up23 = scroll(collapsed, 977);
    expect(up23.phase).toBe("collapsed");
    expect(up23.travel).toBe(23);
    const up24 = scroll(collapsed, 976);
    expect(up24.phase).toBe("expanded");
    expect(up24.travel).toBe(0);

    // Asymmetric 23 down, 1 up, 2 down: each reversal discards the accumulator
    // and seeds it with the current step.
    let asymmetric = scroll(expanded, 1023);
    asymmetric = scroll(asymmetric, 1022);
    expect(asymmetric.travel).toBe(1);
    asymmetric = scroll(asymmetric, 1024);
    expect(asymmetric.phase).toBe("expanded");
    expect(asymmetric.travel).toBe(-2);

    // Symmetric 20 down then 20 up stays expanded under both the shipped
    // reducer and an accumulate-only mutant; only the asymmetric case above
    // discriminates the reversal branch.
    let symmetric = scroll(expanded, 1020);
    symmetric = scroll(symmetric, 1000);
    expect(symmetric.phase).toBe("expanded");
    expect(symmetric.travel).toBe(20);
  });

  it("holds the search row open on a live-containment focus pin across non-focus events", () => {
    usePhoneViewport();
    setWindowMetric("scrollY", 2000);
    const view = render(shellFixture({ collapseSearchOnScroll: true, routeIdentity: itemIdentity }));
    expect(shellStateAttribute(view.container)).toBe("collapsed");

    const input = screen.getByLabelText("Marketplace search fixture");
    act(() => {
      input.focus();
    });
    expect(shellStateAttribute(view.container)).toBe("expanded");

    // A scroll event carrying 24px or more of downward travel past the floor is
    // not a focuschange; live containment at this event keeps the row open.
    const header = view.container.querySelector("div.contents");
    expect(header).not.toBeNull();
    expect(header!.contains(document.activeElement)).toBe(true);
    driveScroll(2030);
    expect(shellStateAttribute(view.container)).toBe("expanded");

    // Across a query-navigation re-render while focus never leaves the header.
    view.rerender(
      shellFixture({ collapseSearchOnScroll: true, routeIdentity: itemIdentity, children: <div>results</div> }),
    );
    expect(document.activeElement).toBe(input);
    expect(header!.contains(document.activeElement)).toBe(true);
    driveScroll(2060);
    expect(shellStateAttribute(view.container)).toBe("expanded");

    // Only after focus truly leaves the header and a further 24px of downward
    // travel past the floor accumulates does the row collapse; the release
    // itself never collapses the row.
    act(() => {
      input.blur();
    });
    expect(shellStateAttribute(view.container)).toBe("expanded");
    expect(header!.contains(document.activeElement)).toBe(false);
    driveScroll(2084);
    expect(shellStateAttribute(view.container)).toBe("collapsed");
    view.unmount();
  });

  it("publishes the collapsed geometry override on the same attribute the shell writes", () => {
    usePhoneViewport();
    setWindowMetric("scrollY", 2000);
    const view = render(shellFixture({ collapseSearchOnScroll: true, routeIdentity: itemIdentity }));
    const outer = view.container.querySelector("div.min-h-screen")!;
    expect(outer.getAttribute("data-search-row-state")).toBe("collapsed");
    expect(outer.getAttribute("class")).toContain(collapsedOverrideClass);

    driveScroll(1976);
    expect(outer.getAttribute("data-search-row-state")).toBe("expanded");
    expect(outer.getAttribute("class")).toContain(collapsedOverrideClass);
    view.unmount();
  });

  it("resolves the closed route policy table as an equality on canonical identities", () => {
    const pathnames = [
      "/search",
      "/search/charizard-does-not-exist",
      itemIdentity,
      "/categories/pokemon",
      "/account/listings",
    ] as const;
    type TableRow = { routeIdentity: string; focusInHeader: boolean; expected: "expanded" | "collapsed" };
    const table: TableRow[] = pathnames.flatMap((routeIdentity) => [
      {
        routeIdentity,
        focusInHeader: false,
        expected: routeIdentity === "/search" ? ("expanded" as const) : ("collapsed" as const),
      },
      { routeIdentity, focusInHeader: true, expected: "expanded" as const },
    ]);

    // The real reducer resolves every row of the closed table under the armed
    // high-scroll environment.
    for (const row of table) {
      const result = searchRowReducer(createInitialSearchRowState(row.routeIdentity), {
        type: "mount",
        environment: {
          enabled: true,
          hasSearch: true,
          belowMd: true,
          scrollY: 2000,
          focusInHeader: row.focusInHeader,
          routeIdentity: row.routeIdentity,
        },
      });
      expect(`${row.routeIdentity} focus=${String(row.focusInHeader)} ${result.phase}`).toBe(
        `${row.routeIdentity} focus=${String(row.focusInHeader)} ${row.expected}`,
      );
    }

    // Synthetic opposite-policy control: a policy that lets /search collapse
    // fails this table; the table is not satisfiable by the inverted equality.
    const oppositePolicy = (routeIdentity: string) =>
      routeIdentity === "/search" ? ("collapsible" as const) : ("always-expanded" as const);
    const resolveWithPolicy = (policy: (routeIdentity: string) => "always-expanded" | "collapsible", row: TableRow) => {
      if (policy(row.routeIdentity) === "always-expanded") {
        return "expanded";
      }
      if (row.focusInHeader) {
        return "expanded";
      }
      return SEED_PHASE;
    };
    const realMismatches = table.filter((row) => resolveWithPolicy(searchRowPolicy, row) !== row.expected);
    const oppositeMismatches = table.filter((row) => resolveWithPolicy(oppositePolicy, row) !== row.expected);
    expect(realMismatches).toEqual([]);
    expect(oppositeMismatches.length).toBeGreaterThan(0);
    expect(
      oppositeMismatches.some((row) => row.routeIdentity === "/search" && !row.focusInHeader),
    ).toBe(true);
  });

  it("leaves omitting shell and TopNav callers byte-identical to exact main across a downward scroll", async () => {
    usePhoneViewport();
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");

    const shellView = render(shellFixture({}));
    expect(shellView.container.innerHTML).toBe(exactMainShellGolden);
    expect(shellView.container.querySelector("[data-search-row-state]")).toBeNull();
    const omittingOuter = shellView.container.querySelector("div.min-h-screen")!;
    expect(await resolveShellHeaderHeightPx(omittingOuter)).toBe(124);
    driveScroll(200);
    expect(shellView.container.innerHTML).toBe(exactMainShellGolden);
    expect(await resolveShellHeaderHeightPx(omittingOuter)).toBe(124);
    // No vacated strip and no reserved/painted split exists for an omitting
    // caller: the exact-main nav is the single header box.
    expect(shellView.container.querySelector("[data-shell-header-box]")).toBeNull();
    shellView.unmount();

    setWindowMetric("scrollY", 0);
    const topNavView = render(
      <TopNav
        brand={<a href="/">Chase Sets</a>}
        items={[{ key: "browse", label: "Browse", href: "/search" }]}
        search={<input aria-label="Marketplace search fixture" />}
      />,
    );
    expect(topNavView.container.innerHTML).toBe(exactMainTopNavGolden);
    driveScroll(200);
    expect(topNavView.container.innerHTML).toBe(exactMainTopNavGolden);
    topNavView.unmount();

    const scrollRegistrations = addEventListenerSpy.mock.calls.filter(([eventName]) => eventName === "scroll");
    expect(scrollRegistrations).toEqual([]);
    addEventListenerSpy.mockRestore();

    // An armed control on the same fixture still resolves the collapsed
    // geometry once collapsed, so the omitting result is a proven default and
    // not a dead code path.
    setWindowMetric("scrollY", 2000);
    const armedView = render(shellFixture({ collapseSearchOnScroll: true, routeIdentity: itemIdentity }));
    const armedOuter = armedView.container.querySelector("div.min-h-screen")!;
    expect(armedOuter.getAttribute("data-search-row-state")).toBe("collapsed");
    expect(await resolveShellHeaderHeightPx(armedOuter)).toBe(64);
    driveScroll(1976);
    expect(armedOuter.getAttribute("data-search-row-state")).toBe("expanded");
    expect(await resolveShellHeaderHeightPx(armedOuter)).toBe(124);
    armedView.unmount();
  });

  it("keeps the search-row phase hook off the design-system export surface", () => {
    expect(Object.keys(DesignSystem)).not.toContain("useSearchRowPhase");
    expect(Object.keys(DesignSystem)).not.toContain("searchRowReducer");
    expect(Object.keys(DesignSystem)).not.toContain("observeSearchRowEvents");
    // The shell itself stays published; only the slice-internal module is off
    // the surface.
    expect(Object.keys(DesignSystem)).toContain("MarketplaceShell");
  });
});
