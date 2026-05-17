import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ActorIdentityCue,
  AccountMenu,
  AppliedFilterChips,
  BottomSheet,
  BottomNav,
  BuyerProtectionBadge,
  CommerceSheet,
  UiBadge as Badge,
  UiButton as Button,
  UiCard as Card,
  UiCardContent as CardContent,
  UiCardHeader as CardHeader,
  UiCardTitle as CardTitle,
  UiDialog as Dialog,
  Input,
  NavigationHeader,
  TopNav,
  ThemeToggle,
  ListingCard,
  TrustBadge,
  VerifiedSellerBadge,
  SecurePaymentCue,
  SellerTrustCard,
  SideSheet,
  PriceBreakdown,
  BuyerProtectionModule,
  ComparisonModule,
  FilterBar,
  FullPage,
  ModalDialog,
  NavigationDrawer,
  SavedSearchPrompt,
  SearchFilterPanel,
  SearchInput,
  Sidebar,
  StickyCtaBar,
  MarketplaceFacetChoiceGroup,
  MarketplaceFilterBottomSheet,
  MarketplaceMobileFilterBar,
  MarketplaceEmptyState,
  MarketplaceCartLineItem,
  MarketplaceStatusTimeline,
  MarketplaceTemplateGallery,
  MessageThreadPreview,
  ListingPurchasePanel,
  MarketingVisualCard,
  OrderIntentSummary,
  OfferCard,
  PaymentRecoveryPanel,
  ProductSelectionSummary,
  ProductMediaModule,
  ResponsiveEditSheet,
  ReviewCard,
  SearchControlBar,
  SellerProfileHeader,
  SellerCredibilityHeader,
  UiSelect as Select,
  UiTable as Table,
  UiTableBody as TableBody,
  UiTableCell as TableCell,
  UiTableHead as TableHead,
  UiTableHeader as TableHeader,
  UiTableRow as TableRow,
  UiTabs as Tabs,
  UiTextarea as Textarea,
  UiTooltip as Tooltip,
  TextInput,
  formatMarketplaceNumber
} from "../index";

describe("design-system", () => {
  it("renders primitive components on the server", () => {
    const markup = renderToString(
      <Card>
        <CardHeader>
          <CardTitle>Listing tools</CardTitle>
        </CardHeader>
        <CardContent>
          <Button>Save</Button>
          <Badge variant="success">Ready</Badge>
          <Input defaultValue="Charizard" />
          <Textarea defaultValue="Seller note" />
        </CardContent>
      </Card>
    );

    expect(markup).toContain("Listing tools");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Charizard");
  });

  it("renders actor identity cues in shell and panel variants", () => {
    const shellMarkup = renderToString(
      <ActorIdentityCue
        title="Signed-In Identity"
        accountLabel="Acting as"
        accountName="Card Vault"
        userLabel="Signed in as"
        userName="Alex Clerk"
        membershipLabel="Membership"
        membershipName="Manager"
      />
    );
    const panelMarkup = renderToString(
      <ActorIdentityCue
        variant="panel"
        title="Signed-In Identity"
        description="Confirm the account and user before work starts."
        accountLabel="Account"
        accountName="Card Vault"
        accountDetail="Selected account"
        userLabel="User"
        userName="Alex Clerk"
        userDetail="alex@example.com"
        membershipLabel="Membership"
        membershipName="Manager"
        membershipDetail="Active membership"
      />
    );

    expect(shellMarkup).toContain("Acting as");
    expect(shellMarkup).toContain("Signed in as");
    expect(panelMarkup).toContain("Signed-In Identity");
    expect(panelMarkup).toContain("alex@example.com");
  });

  it("opens account menus with account links and sign out", async () => {
    const user = userEvent.setup();

    render(
      <div>
        <form id="account-menu-sign-out" action="/sign-out" method="post" />
        <AccountMenu
          accountName="Card Vault"
          roleName="Manager"
          userName="Alex Clerk"
          items={[
            { key: "account", label: "Account", href: "/account", icon: "user" },
            { key: "wallet", label: "Wallet", href: "/account/settlement", icon: "wallet" },
          ]}
          signOutFormId="account-menu-sign-out"
          signOutLabel="Sign Out"
        />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Account menu" }));

    expect(await screen.findByText("Alex Clerk")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Account" }).getAttribute("href")).toBe("/account");
    expect(screen.getByRole("menuitem", { name: "Wallet" }).getAttribute("href")).toBe("/account/settlement");
    expect(screen.getByRole("menuitem", { name: "Sign Out" }).getAttribute("form")).toBe("account-menu-sign-out");
  });

  it("renders marketing visual cards with accessible image context", () => {
    const markup = renderToString(
      <MarketingVisualCard
        imageSrc="/assets/waitlist-panels.png"
        imageAlt="Sorted collectible inventory"
        badge="Beta signal"
        title="Move more inventory"
        description="Bulk, raw, graded, and chase cards stay practical to list."
      />,
    );

    expect(markup).toContain("Sorted collectible inventory");
    expect(markup).toContain("Beta signal");
    expect(markup).toContain("Move more inventory");
  });

  it("renders conversion-first marketplace listing signals", () => {
    const markup = renderToString(
      <ListingCard
        title="2020 Pikachu VMAX"
        price="$1,250.00"
        priceDetail="Free insured shipping"
        condition="PSA 10"
        sellerName="Vaulted Collectibles"
        sellerTrustLabel="Verified seller"
        sellerVerified
        sellerMeta="1,248 sales"
        fulfillment="Arrives May 9-11"
        availability="1 available"
        rating={4.9}
        reviewCount="824"
        protection="Buyer protected"
        primaryAction={<Button>Buy now</Button>}
      />
    );

    expect(markup).toContain("2020 Pikachu VMAX");
    expect(markup).toContain("$1,250.00");
    expect(markup).toContain("Verified seller");
    expect(markup).toContain("Buyer protected");
    expect(markup).toContain("Arrives May 9-11");
  });

  it("keeps listing cards to one dominant primary action", () => {
    const markup = renderToString(
      <ListingCard
        title="1999 Base Set Charizard"
        price="$428.00"
        sellerName="Mint Table Cards"
        sellerTrustLabel="Verified seller"
        sellerTrust={<VerifiedSellerBadge label="Verified seller" />}
        fulfillment="Ships tomorrow"
        availability="1 available"
        primaryAction={<Button>Buy now</Button>}
      />
    );

    expect(markup).toContain('data-primary-action-count="1"');
    expect(markup).toContain("Buy now");
    expect(markup).not.toContain("View details");
  });

  it("surfaces an explicit seller trust signal even when the seller is not verified", () => {
    const markup = renderToString(
      <ListingCard
        title="Raw Squirtle lot"
        price="$18.00"
        sellerName="New seller"
        sellerTrustLabel="Seller details visible"
        fulfillment="Pickup or shipping confirmed before checkout"
        availability="4 available"
        primaryAction={<Button>View details</Button>}
      />
    );

    expect(markup).toContain("Seller details visible");
    expect(markup).toContain("Pickup or shipping confirmed before checkout");
  });

  it("renders named trust components with visible text and icons", () => {
    const markup = renderToString(
      <div>
        <VerifiedSellerBadge label="Verified seller" />
        <BuyerProtectionBadge label="Buyer protected" />
        <SecurePaymentCue label="Secure payment" />
      </div>
    );

    expect(markup).toContain("Verified seller");
    expect(markup).toContain("Buyer protected");
    expect(markup).toContain("Secure payment");
    expect(markup).toContain("<svg");
  });

  it("keeps unsafe marketplace numbers out of rendered copy", () => {
    expect(formatMarketplaceNumber(Number.NaN, "Unavailable")).toBe("Unavailable");
    expect(formatMarketplaceNumber(undefined, "Not listed")).toBe("Not listed");
    expect(formatMarketplaceNumber("12", "Unavailable")).toBe("12");
  });

  it("renders selected product details as structured marketplace chips", () => {
    render(
      <ProductSelectionSummary
        selections={[
          { label: "Form", value: "Raw" },
          { label: "Condition", value: "Near Mint" },
        ]}
        summary="Raw / Near Mint"
      />
    );

    expect(screen.getByText("Form: Raw")).toBeTruthy();
    expect(screen.getByText("Condition: Near Mint")).toBeTruthy();
    expect(screen.queryByText("Raw / Near Mint")).toBeNull();
  });

  it("can render an empty selected product summary as a chip", () => {
    render(
      <ProductSelectionSummary
        selections={[]}
        summary="All listings"
        summaryAsChip
      />
    );

    expect(screen.getByText("All listings").className).toContain("rounded");
  });

  it("renders responsive marketplace cart lines with media, product, quantity, and actions", () => {
    const markup = renderToString(
      <MarketplaceCartLineItem
        imageSrc="/fake-cdn/assets/charizard.png"
        imageAlt="Charizard product"
        title="Charizard"
        subtitle="Base Set 4/102 Holo Rare"
        productLabel="Product"
        productSummary={
          <ProductSelectionSummary
            selections={[
              { label: "Form", value: "Raw" },
              { label: "Condition", value: "Near Mint" },
            ]}
          />
        }
        quantityControl={<label>Quantity<input name="quantity" defaultValue="5" /></label>}
        actions={<Button>Update quantity</Button>}
      />
    );

    expect(markup).toContain("data-marketplace-cart-line");
    expect(markup).toContain('src="/fake-cdn/assets/charizard.png"');
    expect(markup).toContain("Raw");
    expect(markup).toContain("Quantity");
    expect(markup).toContain("Update quantity");
  });

  it("renders listing purchase panels with one primary action region", () => {
    const markup = renderToString(
      <ListingPurchasePanel
        title="Ready to buy this listing"
        price="$42.00"
        seller="Card Vault"
        trust="Verified seller"
        availability="3 available"
        fulfillment="Ships from TX"
        policy="Return policy reviewed before payment"
        protection="Buyer protected"
        reassurance="Final totals appear before payment."
        primaryAction={<Button>Buy now</Button>}
        secondaryAction={<Button variant="secondary">Compare market</Button>}
      />
    );

    expect(markup).toContain("Ready to buy this listing");
    expect(markup).toContain("3 available");
    expect(markup).toContain('data-primary-action-count="1"');
  });

  it("renders checkout order intent before payment starts", () => {
    const markup = renderToString(
      <OrderIntentSummary
        title="Charizard Base Set"
        subtitle="Near Mint"
        price="$390.00"
        quantity="1"
        seller="Verified Card Shop"
        availability="Available"
        fulfillment="Ships from IL"
        protection="Buyer protection included"
        paymentStatus="Not charged yet"
      />
    );

    expect(markup).toContain("Charizard Base Set");
    expect(markup).toContain("Verified Card Shop");
    expect(markup).toContain("Not charged yet");
  });

  it("renders search controls with applied filters and saved search recovery", () => {
    const markup = renderToString(
      <SearchControlBar
        search={<Input aria-label="Search" defaultValue="pikachu" />}
        sort={<Select label="Sort" items={[{ label: "Newest", value: "newest" }]} />}
        filters={<Select label="Language" items={[{ label: "All languages", value: "all" }]} />}
        actions={<Button variant="secondary">Clear filters</Button>}
        filterControlsVisibility="desktop"
        appliedFilters={<AppliedFilterChips filters={[{ id: "q", label: "Search: pikachu" }]} />}
        savedSearch={
          <SavedSearchPrompt
            title="Save this search"
            description="Get alerts."
            action={<Button>Save search</Button>}
          />
        }
      />
    );

    expect(markup).toContain("Search: pikachu");
    expect(markup).toContain("Clear filters");
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("hidden lg:block");
    expect(markup).toContain("Save this search");
  });

  it("bottom-aligns filter fields and actions in data-heavy admin filter bars", () => {
    const markup = renderToString(
      <FilterBar actions={<Button variant="secondary">Promote all matching</Button>} sticky={false}>
        <TextInput label="Search" defaultValue="Pikachu" />
        <Select label="Status" items={[{ label: "Observed", value: "observed" }]} />
      </FilterBar>,
    );

    expect(markup).toContain("flex-1 flex-wrap items-end gap-3");
    expect(markup).toContain("flex flex-wrap items-end gap-2 md:self-end");
    expect(markup).toContain("Promote all matching");
  });

  it("does not reserve visible label spacing for hidden-label form controls", () => {
    const markup = renderToString(
      <SearchInput label="Search marketplace" hideLabel defaultValue="pikachu" />
    );

    expect(markup).toContain("Search marketplace");
    expect(markup).toContain("grid gap-2");
    expect(markup).not.toContain("space-y-2");
  });

  it("renders seller credibility and payment recovery contracts", () => {
    const markup = renderToString(
      <>
        <SellerCredibilityHeader
          name="Card Vault"
          verification="Verified seller"
          facts={[{ label: "Response time", value: "Fast" }]}
          policies={[{ label: "Buyer protection", value: "Included" }]}
          contactAction={<Button>Contact seller</Button>}
        />
        <PaymentRecoveryPanel
          statusLabel="Link unavailable"
          title="Payment link expired"
          description="The link is no longer valid."
          chargeStatus="No payment was charged."
          nextStep="Return to cart."
          primaryAction={<Button>Return to cart</Button>}
        />
      </>
    );

    expect(markup).toContain("Card Vault");
    expect(markup).toContain("No payment was charged.");
  });

  it("renders trust, seller, protection, and price modules", () => {
    const markup = renderToString(
      <div>
        <TrustBadge>Verified seller</TrustBadge>
        <SellerTrustCard
          name="Vaulted Collectibles"
          verified
          completedSales="1,248"
          responseTime="< 2 hours"
        />
        <BuyerProtectionModule
          items={[{ title: "Secure payment", description: "Funds are held safely." }]}
        />
        <PriceBreakdown
          lines={[{ label: "Item price", value: "$1,250.00" }]}
          total="$1,420.78"
          totalLabel="Total"
        />
      </div>
    );

    expect(markup).toContain("Verified seller");
    expect(markup).toContain("Vaulted Collectibles");
    expect(markup).toContain("Secure payment");
    expect(markup).toContain("$1,420.78");
    expect(markup).not.toContain("No surprise costs at payment.");
  });

  it("renders search filters with selected chips and saved-search recovery", () => {
    render(
      <div>
        <SearchFilterPanel
          searchLabel="Search marketplace"
          filterLabel="Filters"
          clearLabel="Clear all"
          placeholder="Search listings"
          resultCount="12 results"
          appliedFilters={["Verified sellers"]}
        />
        <AppliedFilterChips
          filters={[{ id: "verified", label: "Verified sellers" }]}
          clearAction={<Button variant="ghost">Clear all</Button>}
        />
        <AppliedFilterChips
          filters={[{ id: "ships", label: "Ships today", onRemove: vi.fn() }]}
          removeLabel={(label) => `Remove ${String(label)}`}
        />
        <SavedSearchPrompt
          title="Save this search"
          description="Get alerts when matching listings appear."
          action={<Button>Save search</Button>}
        />
      </div>
    );

    expect(screen.getByLabelText("Search marketplace")).toBeTruthy();
    expect(screen.getByLabelText("Remove Ships today")).toBeTruthy();
    expect(screen.getAllByText("Verified sellers").length).toBeGreaterThan(1);
    expect(screen.getByText("Save this search")).toBeTruthy();
  });

  it("renders the marketplace mobile filter bottom sheet pattern", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onSelect = vi.fn();

    function MobileFilterHarness() {
      const [open, setOpen] = useState(false);

      return (
        <div>
          <MarketplaceMobileFilterBar
            title="Filters"
            summary="12 results in Pokemon TCG"
            activeFilterCount={2}
            activeFilterLabel="2 active"
            openLabel="Open filters"
            onOpen={() => {
              onOpen();
              setOpen(true);
            }}
          />
          <MarketplaceFilterBottomSheet
            open={open}
            onOpenChange={setOpen}
            title="Filters"
            description="Refine results."
            resultSummary="12 results in Pokemon TCG"
            footer={<Button>Show results</Button>}
          >
            <MarketplaceFacetChoiceGroup
              title="Condition"
              description="Narrow by condition."
              allLabel="Any Condition"
              items={[
                { id: "near-mint", label: "Near Mint", count: 7 },
                { id: "excellent", label: "Excellent", count: 3 },
                { id: "lightly-played", label: "Lightly Played", count: 2 },
              ]}
              selectedIds={["near-mint", "excellent"]}
              selectionMode="multiple"
              onSelect={onSelect}
            />
          </MarketplaceFilterBottomSheet>
        </div>
      );
    }

    render(<MobileFilterHarness />);

    await user.click(screen.getByRole("button", { name: "Open filters" }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("dialog", { name: "Filters" })).toBeTruthy();
    expect(screen.getByText("2 active")).toBeTruthy();
    expect(screen.getAllByText("12 results in Pokemon TCG").length).toBeGreaterThan(1);
    expect(screen.getByRole("button", { name: "Near Mint (7)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Excellent (3)" }).getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Lightly Played (2)" }));
    expect(onSelect).toHaveBeenCalledWith("lightly-played");
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
            { key: "reports", label: "Reports", href: "/reports" }
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
      </div>
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
      </div>
    );

    await user.click(screen.getByRole("button", { name: "Preview cart action" }));
    expect(await screen.findByRole("dialog", { name: "Add matching products" })).toBeTruthy();
    expect(screen.getByText("Bulk add preview")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Edit shipping address" }));
    expect(await screen.findByRole("dialog", { name: "Update address" })).toBeTruthy();
    expect(screen.getByText("Address form")).toBeTruthy();
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
      </div>
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
        secondaryAction={<Button variant="outline">Edit cart</Button>}
      />
    );

    expect(markup).toContain("$472.19");
    expect(markup).toContain('data-primary-action-count="1"');
    expect(markup).toContain("Final total before payment");
    expect(markup).toContain("Continue to payment");
    expect(markup).toContain("Edit cart");
  });

  it("renders marketplace detail, seller, review, and comparison templates", () => {
    const markup = renderToString(
      <div>
        <ProductMediaModule title="Pikachu VMAX" media={[{ alt: "Front scan", label: "Front" }]} />
        <SellerProfileHeader
          name="Vaulted Collectibles"
          verified
          stats={[{ label: "Completed sales", value: "1,248" }]}
        />
        <ReviewCard
          author="Jordan M."
          rating={5}
          verified
          body="Arrived as described."
        />
        <ComparisonModule
          columns={["Seller A", "Seller B"]}
          rows={[{ label: "Total price", values: ["$120", "$124"] }]}
        />
      </div>
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
          recommendations={["Remove PSA 10"]}
        />
        <MarketplaceStatusTimeline
          steps={[
            { label: "Order confirmed", status: "complete" },
            { label: "Delivery in progress", status: "current" }
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
              primaryAction: "Confirm payment"
            }
          ]}
        />
      </div>
    );

    expect(markup).toContain("No exact matches");
    expect(markup).toContain("Order confirmed");
    expect(markup).toContain("Vaulted Collectibles");
    expect(markup).toContain("Offer pending");
    expect(markup).toContain("Confirm payment");
  });

  it("renders tables with headers and rows", () => {
    const markup = renderToString(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell data-label="Name">Pikachu</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );

    expect(markup).toContain("Name");
    expect(markup).toContain("Pikachu");
    expect(markup).toContain('data-label="Name"');
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
          { href: "/marketplace", label: "Marketplace" }
        ]}
      />
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
          { key: "catalog-items", label: "Catalog Items", href: "/catalog-items" }
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "Catalog Items" })).toBeTruthy();
  });

  it("closes top navigation child menus when clicking outside", async () => {
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
      </div>
    );

    const summary = screen.getByText("Sell").closest("summary");
    expect(summary).toBeTruthy();

    const details = summary?.closest("details");
    expect(details?.open).toBe(false);

    await user.click(summary!);
    expect(details?.open).toBe(true);

    await user.click(screen.getByRole("button", { name: "Outside" }));

    await waitFor(() => expect(details?.open).toBe(false));
  });

  it("syncs theme toggle choices to the document theme", async () => {
    const user = userEvent.setup();
    const storage = new Map<string, string>();

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      }
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

  it("changes select values through Base UI", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <Select
        label="Condition"
        items={[
          { value: "lp", label: "Lightly Played" },
          { value: "nm", label: "Near Mint" }
        ]}
        onValueChange={onValueChange}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Condition" }));
    await user.click(await screen.findByRole("option", { name: "Near Mint" }));

    expect(onValueChange).toHaveBeenCalledWith("nm");
  });

  it("renders tabs and panels", () => {
    render(
      <Tabs
        items={[
          { value: "summary", label: "Summary", content: <div>Summary content</div> },
          { value: "activity", label: "Activity", content: <div>Activity content</div> }
        ]}
      />
    );

    expect(screen.getByRole("tab", { name: "Summary" })).toBeTruthy();
    expect(screen.getByText("Summary content")).toBeTruthy();
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
      </Dialog>
    );

    await user.click(screen.getByRole("button", { name: "Open review" }));

    expect(await screen.findByRole("dialog", { name: "Review listing" })).toBeTruthy();
    expect(screen.getByText("Dialog content")).toBeTruthy();
  });

  it("shows tooltips from focus", async () => {
    render(
      <Tooltip content="Margin includes shipping credit.">
        <button type="button">Margin help</button>
      </Tooltip>
    );

    fireEvent.focus(screen.getByRole("button", { name: "Margin help" }));

    expect(await screen.findByText("Margin includes shipping credit.")).toBeTruthy();
  });
});
