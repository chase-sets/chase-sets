import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type MouseEvent, useState } from "react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as DesignSystem from "../index";
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

  it("publishes measured mobile dock height as a combined shell-and-dock clearance variable", () => {
    class ResizeObserverStub {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = ResizeObserverStub;

    const { unmount } = render(
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

    const rootStyle = document.documentElement.style;
    expect(rootStyle.getPropertyValue("--product-detail-mobile-dock-height")).not.toBe("");
    expect(rootStyle.getPropertyValue("--product-detail-mobile-dock-clearance")).toContain("--shell-bottom-nav-height");
    expect(rootStyle.scrollPaddingBottom).toBe("var(--product-detail-mobile-dock-clearance)");

    unmount();

    expect(rootStyle.getPropertyValue("--product-detail-mobile-dock-height")).toBe("");
    expect(rootStyle.getPropertyValue("--product-detail-mobile-dock-clearance")).toBe("");
    expect(rootStyle.scrollPaddingBottom).toBe("");

    globalThis.ResizeObserver = originalResizeObserver;
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
