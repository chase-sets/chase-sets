import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as designSystem from "../index";
import {
  ActorIdentityCue,
  AccountMenu,
  ActionBar,
  AppliedFilterChips,
  BottomSheet,
  BottomNav,
  BulkActionBar,
  BulkActionPanel,
  BulkActionSurface,
  CommerceSheet,
  UiBadge as Badge,
  Button,
  UiCard as Card,
  UiCardContent as CardContent,
  UiCardHeader as CardHeader,
  UiCardTitle as CardTitle,
  UiDialog as Dialog,
  Inline,
  NavigationHeader,
  AccountReputationSummary,
  OrderProtectionBadge,
  TopNav,
  ThemeToggle,
  ListingCard,
  TrustBadge,
  VerifiedAccountBadge,
  SecurePaymentCue,
  AccountTrustCard,
  SideSheet,
  PriceBreakdown,
  ActivitySheet,
  AssistantSheet,
  OrderProtectionModule,
  ComparisonModule,
  FilterArea,
  FilterBar,
  FullPage,
  ModalDialog,
  NavigationDrawer,
  ResponsiveActionMenu,
  SavedSearchPrompt,
  SearchFilterPanel,
  SearchInput,
  Sidebar,
  StickyCtaBar,
  StickyTaskFooter,
  Tabs as ActionTabs,
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
  MarketplaceFacetChoiceGroup,
  MarketplaceFacetRail,
  MarketplaceFilterBottomSheet,
  MarketplaceMobileFilterBar,
  MarketplaceProductDetailLayout,
  MarketplaceEmptyState,
  MarketplaceCartLineItem,
  MarketplaceStatusTimeline,
  MarketplaceTemplateGallery,
  MessageThreadPreview,
  ListingPurchasePanel,
  MarketingImageHero,
  MarketingVisualCard,
  OrderIntentSummary,
  OfferCard,
  TaskReference,
  TaskScanInput,
  PaymentRecoveryPanel,
  ProductOptions,
  ProductMediaModule,
  ResponsiveEditSheet,
  ReviewCard,
  SearchControlBar,
  AccountProfileHeader,
  AccountCredibilityHeader,
  Select,
  UiTable as Table,
  UiTableBody as TableBody,
  UiTableCell as TableCell,
  UiTableHead as TableHead,
  UiTableHeader as TableHeader,
  UiTableRow as TableRow,
  UiTabs as Tabs,
  Textarea,
  UiTooltip as Tooltip,
  TextInput,
  formatProductImageAltText,
  formatProductOptionsAriaLabel,
  productOptionsFromSummary,
  formatMarketplaceNumber,
  chaseTheme,
} from "../index";

describe("design-system", () => {
  it("does not expose deprecated design-system aliases", () => {
    const retiredAliasNames = [
      ["Drawer"],
      ["Filter", "Drawer"],
      ["Marketplace", "Mobile", "Filter", "Drawer"],
      ["Marketplace", "Filter", "Drawer"],
      ["Marketplace", "Ui", "Filter", "Bottom", "Sheet"],
      ["Commerce", "Drawer"],
      ["Notification", "Center", "Drawer"],
      ["Dropdown", "Menu"],
      ["Ui", "Button"],
      ["Ui", "Button", "Props"],
      ["Ui", "Button", "Size"],
      ["Ui", "Button", "Variant"],
      ["Input"],
      ["Ui", "Select"],
      ["Ui", "Select", "Item"],
      ["Ui", "Select", "Props"],
      ["Ui", "Textarea"],
    ].map((parts) => parts.join(""));

    for (const aliasName of retiredAliasNames) {
      expect(designSystem).not.toHaveProperty(aliasName);
    }
  });

  it("layers dropdown and popover panels above modal panels", () => {
    const layers = chaseTheme.zIndex;

    expect(Number(layers.dropdown)).toBeGreaterThan(Number(layers.modal));
    expect(Number(layers.popover)).toBeGreaterThan(Number(layers.modal));
    expect(Number(layers.toast)).toBeGreaterThan(Number(layers.popover));
  });

  it("renders primitive components on the server", () => {
    const markup = renderToString(
      <Card>
        <CardHeader>
          <CardTitle>Listing tools</CardTitle>
        </CardHeader>
        <CardContent>
          <Button>Save</Button>
          <Badge variant="success">Ready</Badge>
          <TextInput label="Card" hideLabel defaultValue="Charizard" />
          <Textarea label="Seller note" hideLabel defaultValue="Seller note" />
        </CardContent>
      </Card>,
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
      />,
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
      />,
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
        imageLoading="lazy"
        imageDecoding="async"
        imageWidth={1200}
        imageHeight={900}
        badge="Beta signal"
        title="Move more inventory"
        description="Bulk, raw, graded, and chase cards stay practical to list."
      />,
    );

    expect(markup).toContain("Sorted collectible inventory");
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('decoding="async"');
    expect(markup).toContain('width="1200"');
    expect(markup).toContain("Beta signal");
    expect(markup).toContain("Move more inventory");
    expect(markup).toContain("max-w-[34rem] text-pretty");
  });

  it("passes first-paint image hints through marketing heroes", () => {
    const markup = renderToString(
      <MarketingImageHero
        imageSrc="/assets/hero.webp"
        imageAlt="Cards ready to list"
        imageLoading="eager"
        imageDecoding="async"
        imageFetchPriority="high"
        imageWidth={1600}
        imageHeight={1000}
        density="compact"
        title="List cards without giving up margin"
        conversionPanel={<form aria-label="Early access form" />}
        highlights={[
          { label: "Seller fee", value: "0% beta listings" },
          { label: "Buyer totals", value: "Visible before payment" },
        ]}
      />,
    );

    expect(markup).toContain("Cards ready to list");
    expect(markup).toContain('loading="eager"');
    expect(markup).toContain('decoding="async"');
    expect(markup).toContain('fetchPriority="high"');
    expect(markup).toContain('width="1600"');
    expect(markup).toContain("min-h-[18rem]");
    expect(markup).toContain("Marketing highlights");
    expect(markup).toContain("Seller fee");
    expect(markup).toContain("0% beta listings");
  });

  it("renders conversion-first marketplace listing signals", () => {
    const markup = renderToString(
      <ListingCard
        title="2020 Pikachu VMAX"
        imageSrc="/assets/pikachu.webp"
        imageAlt="Pikachu VMAX card"
        imageLoading="lazy"
        imageDecoding="async"
        imageWidth={420}
        imageHeight={587}
        price="$1,250.00"
        priceDetail="Free insured shipping"
        condition="PSA 10"
        sellerName="Vaulted Collectibles"
        sellerTrustLabel="Verified account"
        sellerVerified
        sellerMeta="1,248 sales"
        fulfillment="Arrives May 9-11"
        availability="1 available"
        rating={4.9}
        reviewCount="824"
        protection="Order protected"
        primaryAction={<Button>Buy now</Button>}
      />,
    );

    expect(markup).toContain("2020 Pikachu VMAX");
    expect(markup).toContain("Pikachu VMAX card");
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('width="420"');
    expect(markup).toContain('height="587"');
    expect(markup).toContain("$1,250.00");
    expect(markup).toContain("Verified account");
    expect(markup).toContain("Order protected");
    expect(markup).toContain("Arrives May 9-11");
  });

  it("renders listing product media without image padding or surface chrome", () => {
    const markup = renderToString(
      <ListingCard
        title="2020 Pikachu VMAX"
        imageSrc="/assets/pikachu-vmax.webp"
        imageAlt="2020 Pikachu VMAX card"
        price="$1,250.00"
        sellerName="Vaulted Collectibles"
        sellerTrustLabel="Verified account"
        fulfillment="Arrives May 9-11"
        availability="1 available"
        primaryAction={<Button>Buy now</Button>}
      />,
    );

    expect(markup).toContain('src="/assets/pikachu-vmax.webp"');
    expect(markup).toContain("object-contain");
    expect(markup).toContain("bg-transparent");
    expect(markup).not.toContain("object-contain p-3");
  });

  it("renders listing product media from responsive image descriptors", () => {
    const markup = renderToString(
      <ListingCard
        title="2020 Pikachu VMAX"
        image={{
          src: "/assets/pikachu-160w.webp",
          srcSet: "/assets/pikachu-160w.webp 160w, /assets/pikachu-320w.webp 320w",
          sizes: "160px",
          width: 160,
          height: 224,
        }}
        imageAlt="2020 Pikachu VMAX card"
        imageSlot="compact-product"
        price="$1,250.00"
        sellerName="Vaulted Collectibles"
        sellerTrustLabel="Verified account"
        fulfillment="Arrives May 9-11"
        availability="1 available"
        primaryAction={<Button>Buy now</Button>}
      />,
    );

    expect(markup).toContain('src="/assets/pikachu-160w.webp"');
    expect(markup).toContain('srcSet="/assets/pikachu-160w.webp 160w, /assets/pikachu-320w.webp 320w"');
    expect(markup).toContain('sizes="160px"');
    expect(markup).toContain('width="160"');
    expect(markup).toContain('height="224"');
    expect(markup).toContain("max-w-[10rem]");
  });

  it("renders search result cards as side-by-side product-first cards without redundant market copy", () => {
    const markup = renderToString(
      <ListingCard
        cardLayout="search-result"
        title="Abra 054/132"
        subtitle="Base Set 43 Parallel Set - Reverse Foil Common"
        image={{
          src: "/assets/abra-224w.webp",
          srcSet: "/assets/abra-224w.webp 224w, /assets/abra-448w.webp 448w",
          sizes: "(min-width: 768px) 164px, 124px",
          width: 224,
          height: 314,
        }}
        imageAlt="Abra card"
        imageSlot="compact-product"
        primaryAction={<Button>Sell</Button>}
        secondaryAction={false}
      />,
    );

    expect(markup).toContain('data-card-layout="search-result"');
    expect(markup).toContain("grid-cols-[minmax(7.5rem,8.25rem)_minmax(0,1fr)]");
    expect(markup).toContain("md:grid-cols-[minmax(10.5rem,12.5rem)_minmax(0,1fr)]");
    expect(markup).toContain("max-w-[7.25rem]");
    expect(markup).toContain("md:max-w-[10.25rem]");
    expect(markup).toContain("Base Set 43 Parallel Set - Reverse Foil Common");
    expect(markup).not.toContain("line-clamp-1");
    expect(markup).not.toContain("Market open");
    expect(markup).not.toContain("Offers open");
    expect(markup).not.toContain("Offer or list yours");
    expect(markup).toContain("flex flex-wrap items-center gap-2 pt-1");
    expect(markup).not.toContain('data-card-promotion-placement="content"');
    expect(markup).not.toContain("Supply wanted");
    expect(markup).not.toContain("absolute left-2 top-2");
  });

  it("keeps loading-only fallback images out of the product-back preview layer", () => {
    const markup = renderToString(
      <ListingCard
        cardLayout="search-result"
        title="Prismatic Evolutions Booster Pack"
        imageSrc="/assets/booster-pack.webp"
        imageAlt="Prismatic Evolutions Booster Pack"
        imageSlot="compact-product"
        imageFallbackSrc="/assets/pokemon-card-back.webp"
        imageFallbackAlt="Pokemon sealed product loading image"
        imageFallbackMode="loading-only"
        primaryAction={<Button>Sell</Button>}
        secondaryAction={false}
      />,
    );

    expect(markup).toContain("/assets/booster-pack.webp");
    expect(markup).not.toContain("/assets/pokemon-card-back.webp");
  });

  it("keeps permanent fallback images visible as search result card-back previews", () => {
    const markup = renderToString(
      <ListingCard
        cardLayout="search-result"
        title="Bayleef 002/132"
        imageSrc="/assets/bayleef-front.webp"
        imageAlt="Bayleef 002/132"
        imageSlot="compact-product"
        imageFallbackSrc="/assets/pokemon-card-back.webp"
        imageFallbackAlt="Pokemon card back"
        imageFallbackMode="permanent"
        primaryAction={<Button>Sell</Button>}
        secondaryAction={false}
      />,
    );

    expect(markup).toContain("/assets/bayleef-front.webp");
    expect(markup).toContain("/assets/pokemon-card-back.webp");
    expect(markup).toContain("-translate-x-2");
    expect(markup).toContain("opacity-75");
    expect(markup).toContain("z-10");
  });

  it("keeps search-result media placeholders free of generic product copy", () => {
    const markup = renderToString(
      <ListingCard
        cardLayout="search-result"
        title="Prismatic Evolutions Booster Pack"
        subtitle="Sealed booster pack"
        imageSlot="compact-product"
        showMediaPlaceholder
        primaryAction={<Button>Sell</Button>}
        secondaryAction={false}
      />,
    );

    expect(markup).toContain("Prismatic Evolutions Booster Pack");
    expect(markup).toContain("Sealed booster pack");
    expect(markup).not.toContain(">Product<");
  });

  it("renders linked account reputation summaries", () => {
    render(
      <div>
        <AccountReputationSummary
          accountName="Card Vault"
          href="/accounts/card-vault#feedback"
          averageRating="4.95"
          reviewCount={18}
          ratingLabel="Card Vault reputation"
        />
        <AccountReputationSummary accountName="New Account" />
      </div>,
    );

    const accountLink = screen.getByRole("link", { name: "Card Vault" });
    expect(accountLink.getAttribute("href")).toBe("/accounts/card-vault#feedback");
    expect(accountLink.parentElement?.className).toContain("flex-col");
    expect(screen.getByText("5.0")).toBeTruthy();
    expect(screen.getByText("(18)")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
    expect(screen.queryByText("View feedback")).toBeNull();
  });

  it("renders account reputation once inside listing trust rows", () => {
    render(
      <ListingCard
        title="2020 Pikachu VMAX"
        price="$1,250.00"
        sellerName="Vaulted Collectibles"
        sellerTrustLabel="Verified account"
        sellerVerified
        fulfillment="Arrives May 9-11"
        availability="1 available"
        rating={4.9}
        reviewCount="824"
        primaryAction={<Button>Buy now</Button>}
      />,
    );

    expect(screen.getByText("Vaulted Collectibles")).toBeTruthy();
    expect(screen.getByText("Verified account")).toBeTruthy();
    expect(screen.getAllByText("4.9")).toHaveLength(1);
    expect(screen.getAllByText("(824)")).toHaveLength(1);
  });

  it("keeps listing cards to one dominant primary action", () => {
    const markup = renderToString(
      <ListingCard
        title="1999 Base Set Charizard"
        subtitle="Base Set 4 Standard Set Rare Holo"
        price="$428.00"
        sellerName="Mint Table Cards"
        sellerTrustLabel="Verified account"
        sellerTrust={<VerifiedAccountBadge label="Verified account" />}
        fulfillment="Ships tomorrow"
        availability="1 available"
        primaryAction={<Button>Buy now</Button>}
      />,
    );

    expect(markup).toContain('data-primary-action-count="1"');
    expect(markup).toContain("Base Set 4 Standard Set Rare Holo");
    expect(markup).toContain("Buy now");
    expect(markup).not.toContain("View details");
  });

  it("surfaces an explicit account trust signal even when the seller is not verified", () => {
    const markup = renderToString(
      <ListingCard
        title="Raw Squirtle lot"
        price="$18.00"
        sellerName="New account"
        sellerTrustLabel="Account details visible"
        fulfillment="Pickup or shipping confirmed before checkout"
        availability="4 available"
        primaryAction={<Button>View details</Button>}
      />,
    );

    expect(markup).toContain("Account details visible");
    expect(markup).toContain("Pickup or shipping confirmed before checkout");
  });

  it("renders named trust components with visible text and icons", () => {
    const markup = renderToString(
      <div>
        <VerifiedAccountBadge label="Verified account" />
        <OrderProtectionBadge label="Order protected" />
        <SecurePaymentCue label="Secure payment" />
      </div>,
    );

    expect(markup).toContain("Verified account");
    expect(markup).toContain("Order protected");
    expect(markup).toContain("Secure payment");
    expect(markup).toContain("max-w-full");
    expect(markup).toContain("break-words");
    expect(markup).toContain("<svg");
  });

  it("renders role-neutral account reputation summaries for transaction accounts", () => {
    const markup = renderToString(
      <div>
        <div>
          <AccountReputationSummary
            accountName="Chase Sets"
            averageRating={5}
            reviewCount={1}
            ratingLabel="Account reputation"
          />
          <Badge variant="success">Account</Badge>
        </div>
        <OfferCard
          title="Offer pending"
          amount="$48.00"
          accountTrust={
            <AccountReputationSummary
              accountName="Ash Ketchum"
              averageRating={4.8}
              reviewCount={12}
              ratingLabel="Ordering account reputation"
            />
          }
        />
      </div>,
    );

    expect(markup).toContain("Account");
    expect(markup).toContain("Ordering account");
    expect(markup).not.toContain("View feedback");
    expect(markup).toContain("Ash Ketchum");
  });

  it("keeps unsafe marketplace numbers out of rendered copy", () => {
    expect(formatMarketplaceNumber(Number.NaN, "Unavailable")).toBe("Unavailable");
    expect(formatMarketplaceNumber(undefined, "Not listed")).toBe("Not listed");
    expect(formatMarketplaceNumber("12", "Unavailable")).toBe("12");
  });

  it("renders selected product details as option-only text with dimension-aware accessibility", () => {
    render(
      <ProductOptions
        options={[
          { dimensionLabel: "Form", optionLabel: "Raw" },
          { dimensionLabel: "Condition", optionLabel: "Near Mint" },
        ]}
      />,
    );

    expect(screen.getByText("Raw")).toBeTruthy();
    expect(screen.getByText("Near Mint")).toBeTruthy();
    expect(screen.getByLabelText("Product options: Form Raw, Condition Near Mint")).toBeTruthy();
    expect(screen.queryByText("Form: Raw")).toBeNull();
    expect(screen.queryByText("Raw / Near Mint")).toBeNull();
  });

  it("maps persisted product summaries into explicit option-only display values", () => {
    const options = productOptionsFromSummary("Form: Graded | Grading Company: PSA | Grade: 10 Gem Mint");

    expect(formatProductOptionsAriaLabel(options)).toBe(
      "Product options: Form Graded, Grading Company PSA, Grade 10 Gem Mint",
    );
    expect(formatProductImageAltText({ title: "Pikachu", options })).toBe("Pikachu, Graded, PSA, 10 Gem Mint");

    render(<ProductOptions options={options} />);

    expect(screen.getByText("Graded")).toBeTruthy();
    expect(screen.getByText("PSA")).toBeTruthy();
    expect(screen.getByText("10 Gem Mint")).toBeTruthy();
    expect(screen.queryByText("Form: Graded")).toBeNull();
  });

  it("can render empty product options with fallback copy", () => {
    render(<ProductOptions options={[]} emptyLabel="All listings" variant="chips" />);

    expect(screen.getByText("All listings")).toBeTruthy();
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
          <ProductOptions
            options={[
              { dimensionLabel: "Form", optionLabel: "Raw" },
              { dimensionLabel: "Condition", optionLabel: "Near Mint" },
            ]}
          />
        }
        quantityControl={
          <label>
            Quantity
            <input name="quantity" defaultValue="5" />
          </label>
        }
        actions={<Button>Update quantity</Button>}
      />,
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
        trust="Verified account"
        availability="3 available"
        fulfillment="Ships from TX"
        policy="Return policy reviewed before payment"
        protection="Order protected"
        reassurance="Final totals appear before payment."
        primaryAction={<Button>Buy now</Button>}
        secondaryAction={<Button tone="secondary">Compare market</Button>}
      />,
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
        protection="Order protection included"
        paymentStatus="Not charged yet"
      />,
    );

    expect(markup).toContain("Charizard Base Set");
    expect(markup).toContain("Verified Card Shop");
    expect(markup).toContain("Not charged yet");
  });

  it("renders search controls with applied filters and saved search recovery", () => {
    const markup = renderToString(
      <SearchControlBar
        search={<SearchInput label="Search" hideLabel defaultValue="pikachu" />}
        sort={<Select label="Sort" items={[{ label: "Newest", value: "newest" }]} />}
        filters={<Select label="Language" items={[{ label: "All languages", value: "all" }]} />}
        actions={<Button tone="secondary">Clear filters</Button>}
        filterControlsVisibility="desktop"
        appliedFilters={<AppliedFilterChips filters={[{ id: "q", label: "Search: pikachu" }]} />}
        savedSearch={
          <SavedSearchPrompt title="Save this search" description="Get alerts." action={<Button>Save search</Button>} />
        }
      />,
    );

    expect(markup).toContain("Search: pikachu");
    expect(markup).toContain("Clear filters");
    expect(markup).toContain("min-h-[var(--control-md-height)]");
    expect(markup).toContain("hidden lg:block");
    expect(markup).toContain("Save this search");
  });

  it("bottom-aligns filter fields in data-heavy admin filter bars", () => {
    const markup = renderToString(
      <FilterArea
        filters={[
          <TextInput key="search" label="Search" defaultValue="Pikachu" />,
          <Select key="status" label="Status" items={[{ label: "Observed", value: "observed" }]} />,
          <TextInput key="provider" label="Provider" defaultValue="tcgdex" />,
        ]}
        activeFilterCount={3}
        overflowTriggerLabel="More filters"
        sticky={false}
      />,
    );

    expect(markup).toContain("lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end");
    expect(markup).toContain("flex min-w-0 flex-1 flex-wrap items-end gap-3");
    expect(markup).toContain("min-w-[12rem] max-w-full");
    expect(markup).toContain("More filters (3 active)");
    expect(markup).not.toContain("Promote all matching");
  });

  it("uses standard widths for direct filter bar controls", () => {
    const markup = renderToString(
      <FilterBar sticky={false}>
        <Select label="Provider" items={[{ label: "All Providers", value: "all" }]} />
        <Select label="Language" items={[{ label: "All Languages", value: "all" }]} />
        <Select label="Expansion" items={[{ label: "All Expansions", value: "all" }]} />
      </FilterBar>,
    );

    expect(markup).toContain("md:[&amp;&gt;*]:w-48");
    expect(markup).toContain("md:[&amp;&gt;*]:min-w-[12rem]");
  });

  it("renders admin commands in action bars", () => {
    const markup = renderToString(
      <ActionBar>
        <Inline>
          <Button tone="secondary">Promote all matching</Button>
          <TextInput label="Reject reason" defaultValue="" />
          <Button tone="danger">Reject matching</Button>
        </Inline>
      </ActionBar>,
    );

    expect(markup).toContain("modern-surface flex min-w-0 flex-wrap items-end");
    expect(markup).toContain("Promote all matching");
    expect(markup).toContain("Reject reason");
    expect(markup).toContain("Reject matching");
  });

  it("bottom-aligns controls and buttons in admin bulk action bars", () => {
    const markup = renderToString(
      <BulkActionBar
        count={169}
        formatSelectedLabel={(count) => `${count} matching Catalog Items`}
        actions={
          <>
            <Select label="Bulk Edit" items={[{ label: "Assign Blueprint", value: "assignBlueprint" }]} />
            <TextInput label="Blueprint ID" defaultValue="bpr_card" />
            <Button tone="secondary">Preview matching</Button>
          </>
        }
      />,
    );

    expect(markup).toContain("169 matching Catalog Items");
    expect(markup).toContain("flex flex-wrap items-end gap-2");
    expect(markup).toContain("Preview matching");
  });

  it("renders bulk action bars with a clear action hierarchy", () => {
    const markup = renderToString(
      <BulkActionBar
        count={25}
        formatSelectedLabel={(count) => `${count} Catalog Items selected`}
        primaryActions={<Button>Preview Publish</Button>}
        secondaryActions={<Button tone="secondary">Clear Selection</Button>}
        overflowActions={[
          { key: "archive", label: "Archive" },
          { key: "remove-drafts", label: "Remove Drafts", destructive: true },
        ]}
      />,
    );

    expect(markup).toContain("25 Catalog Items selected");
    expect(markup).toContain('data-bulk-action-region="primary"');
    expect(markup).toContain("Preview Publish");
    expect(markup).toContain('data-bulk-action-region="secondary"');
    expect(markup).toContain("Clear Selection");
    expect(markup).toContain('data-bulk-action-region="overflow"');
    expect(markup).toContain("More actions");
  });

  it("prevents more than one bottom bulk action bar in a bulk action surface", () => {
    expect(() =>
      renderToString(
        <BulkActionSurface>
          <BulkActionBar count={12} primaryActions={<Button>Preview publish</Button>} />
          <BulkActionBar count={12} primaryActions={<Button>Preview edit</Button>} />
        </BulkActionSurface>,
      ),
    ).toThrow("BulkActionSurface can render only one BulkActionBar");
  });

  it("moves large bulk action sets into a reusable side panel", async () => {
    const user = userEvent.setup();

    render(
      <BulkActionSurface>
        <BulkActionBar
          count={364}
          formatSelectedLabel={(count) => `${count} matching Catalog Items`}
          primaryActions={
            <BulkActionPanel
              title="Bulk actions"
              triggerLabel="Configure action"
              footer={<Button>Preview matching items</Button>}
            >
              <Select label="Action" items={[{ label: "Assign Blueprint", value: "assignBlueprint" }]} />
              <TextInput label="Blueprint ID or slug" defaultValue="bpr_card" />
            </BulkActionPanel>
          }
          secondaryActions={<Button tone="secondary">Preview retire</Button>}
        />
      </BulkActionSurface>,
    );

    expect(screen.getByText("364 matching Catalog Items")).toBeTruthy();
    expect(screen.queryByLabelText("Blueprint ID or slug")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Configure action" }));

    expect(await screen.findByText("Bulk actions")).toBeTruthy();
    expect(screen.getByLabelText("Action")).toBeTruthy();
    expect(screen.getByLabelText("Blueprint ID or slug")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview matching items" })).toBeTruthy();
  });

  it("moves overflow filters into an accessible filter panel", async () => {
    const user = userEvent.setup();

    render(
      <FilterArea
        filters={[
          <TextInput key="search" label="Search" defaultValue="Pikachu" />,
          <Select key="status" label="Status" items={[{ label: "Draft", value: "draft" }]} />,
          <TextInput key="source" label="Source" defaultValue="tcgplayer" />,
          <TextInput key="tag" label="Tag" defaultValue="vintage" />,
        ]}
        activeFilterCount={3}
        panelTitle="Catalog filters"
        overflowTriggerLabel="More filters"
      />,
    );

    expect(screen.getByLabelText("Search")).toBeTruthy();
    expect(screen.queryByLabelText("Source")).toBeNull();

    await user.click(screen.getByRole("button", { name: "More filters (3 active)" }));

    expect(await screen.findByRole("dialog", { name: "Catalog filters" })).toBeTruthy();
    expect(screen.getByLabelText("Source")).toBeTruthy();
    expect(screen.getByLabelText("Tag")).toBeTruthy();
  });

  it("does not reserve visible label spacing for hidden-label form controls", () => {
    const markup = renderToString(<SearchInput label="Search marketplace" hideLabel defaultValue="pikachu" />);

    expect(markup).toContain("Search marketplace");
    expect(markup).toContain("grid gap-2");
    expect(markup).not.toContain("space-y-2");
  });

  it("renders seller credibility and payment recovery contracts", () => {
    const markup = renderToString(
      <>
        <AccountCredibilityHeader
          name="Card Vault"
          verification="Verified account"
          facts={[{ label: "Response time", value: "Fast" }]}
          policies={[{ label: "Order protection", value: "Included" }]}
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
      </>,
    );

    expect(markup).toContain("Card Vault");
    expect(markup).toContain("No payment was charged.");
  });

  it("renders trust, seller, protection, and price modules", () => {
    const markup = renderToString(
      <div>
        <TrustBadge>Verified account</TrustBadge>
        <AccountTrustCard name="Vaulted Collectibles" verified completedSales="1,248" responseTime="< 2 hours" />
        <OrderProtectionModule items={[{ title: "Secure payment", description: "Funds are held safely." }]} />
        <PriceBreakdown lines={[{ label: "Item price", value: "$1,250.00" }]} total="$1,420.78" totalLabel="Total" />
      </div>,
    );

    expect(markup).toContain("Verified account");
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
          appliedFilters={["Verified accounts"]}
        />
        <AppliedFilterChips
          filters={[{ id: "verified", label: "Verified accounts" }]}
          clearAction={<Button tone="ghost">Clear all</Button>}
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
      </div>,
    );

    expect(screen.getByLabelText("Search marketplace")).toBeTruthy();
    expect(screen.getByLabelText("Remove Ships today")).toBeTruthy();
    expect(screen.getAllByText("Verified accounts").length).toBeGreaterThan(1);
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

  it("filters searchable marketplace facet choices without hiding selected values", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <MarketplaceFacetChoiceGroup
        title="Condition"
        allLabel="Any Condition"
        items={[
          { id: "near-mint", label: "Near Mint", count: 7 },
          { id: "excellent", label: "Excellent", count: 3 },
          { id: "foil", label: "Foil", count: 2 },
        ]}
        selectedIds={["near-mint"]}
        selectionMode="multiple"
        onSelect={onSelect}
        searchable
        searchLabel="Search Condition options"
        searchPlaceholder="Find Condition option"
        searchEmptyLabel="No matching Condition options"
      />,
    );

    await user.type(screen.getByRole("searchbox", { name: "Search Condition options" }), "foil");

    expect(screen.getByRole("button", { name: "Near Mint (7)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Foil (2)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Excellent (3)" })).toBeNull();

    await user.clear(screen.getByRole("searchbox", { name: "Search Condition options" }));
    await user.type(screen.getByRole("searchbox", { name: "Search Condition options" }), "etched");

    expect(screen.getByRole("button", { name: "Near Mint (7)" })).toBeTruthy();
    expect(screen.getByText("No matching Condition options")).toBeTruthy();
  });

  it("uses progressive disclosure for long marketplace facet choices without nested scrolling", async () => {
    const user = userEvent.setup();

    const { container } = render(
      <MarketplaceFacetChoiceGroup
        title="Condition"
        allLabel="Any Condition"
        items={Array.from({ length: 9 }, (_, index) => ({
          id: `condition-${index + 1}`,
          label: `Condition ${index + 1}`,
          count: 9 - index,
        }))}
        selectedIds={["condition-9"]}
        selectionMode="multiple"
        onSelect={vi.fn()}
        searchable
        searchLabel="Search Condition options"
      />,
    );

    expect(screen.getByRole("button", { name: "Condition 1 (9)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Condition 6 (4)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Condition 9 (1)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Condition 7 (3)" })).toBeNull();
    expect(container.innerHTML).not.toContain("max-h-72");
    expect(container.innerHTML).not.toContain("overflow-y-auto");

    await user.click(screen.getByRole("button", { name: "Show more" }));

    expect(screen.getByRole("button", { name: "Condition 7 (3)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Condition 8 (2)" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Show less" }));

    expect(screen.queryByRole("button", { name: "Condition 7 (3)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Condition 9 (1)" })).toBeTruthy();
  });

  it("filters searchable marketplace facet rails", async () => {
    const user = userEvent.setup();

    render(
      <MarketplaceFacetRail
        title="Expansion"
        allLabel="Any Expansion"
        items={[
          { id: "base", label: "Base Set", count: 9 },
          { id: "jungle", label: "Jungle", count: 4 },
          { id: "fossil", label: "Fossil", count: 3 },
        ]}
        onSelect={vi.fn()}
        searchable
        searchLabel="Search Expansion options"
      />,
    );

    await user.type(screen.getByRole("searchbox", { name: "Search Expansion options" }), "fossil");

    expect(screen.getByRole("button", { name: "Fossil (3)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Jungle (4)" })).toBeNull();
  });

  it("uses progressive disclosure for long marketplace facet rails without nested scrolling", async () => {
    const user = userEvent.setup();

    const { container } = render(
      <MarketplaceFacetRail
        title="Expansion"
        allLabel="Any Expansion"
        items={Array.from({ length: 9 }, (_, index) => ({
          id: `set-${index + 1}`,
          label: `Set ${index + 1}`,
          count: 9 - index,
        }))}
        selectedId="set-9"
        onSelect={vi.fn()}
        searchable
        searchLabel="Search Expansion options"
      />,
    );

    expect(screen.getByRole("button", { name: "Set 1 (9)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set 6 (4)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set 9 (1)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Set 7 (3)" })).toBeNull();
    expect(container.innerHTML).not.toContain("max-h-72");
    expect(container.innerHTML).not.toContain("overflow-y-auto");

    await user.click(screen.getByRole("button", { name: "Show more" }));

    expect(screen.getByRole("button", { name: "Set 7 (3)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set 8 (2)" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Show less" }));

    expect(screen.queryByRole("button", { name: "Set 7 (3)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Set 9 (1)" })).toBeTruthy();
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
        status={<Badge variant="warning">Blocked</Badge>}
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

    expect(markup).toContain("sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))]");
    expect(markup).not.toContain("fixed inset-x-3");
    expect(markup).not.toContain("h-32 md:hidden");
    expect(markup).toContain("xl:col-span-2");
    expect(markup).toContain("xl:sticky xl:top-20");
    expect(markup).toContain("xl:max-h-[calc(100dvh-5rem)]");
    expect(markup).toContain("xl:overflow-x-hidden");
    expect(markup).toContain("xl:[scrollbar-gutter:stable]");
    expect(markup.indexOf("Offers list")).toBeLessThan(markup.indexOf("Mobile buy sell panel"));
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
          recommendations={["Remove PSA 10"]}
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
      </Table>,
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

  it("collapses top navigation actions into an admin menu for mobile", async () => {
    const user = userEvent.setup();

    render(
      <TopNav
        brand={<div>Catalog Ops</div>}
        items={[]}
        mobileActionsLabel="Admin menu"
        actions={
          <>
            <a href="/experience/waitlist">Experience</a>
            <a href="/identity/accounts">Identity</a>
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
        .getByRole("link", { name: "Experience" })
        .getAttribute("href"),
    ).toBe("/experience/waitlist");
    expect(
      within(menu as HTMLElement)
        .getByRole("link", { name: "Identity" })
        .getAttribute("href"),
    ).toBe("/identity/accounts");
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
      </div>,
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

  it("changes select values through Base UI", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <Select
        label="Condition"
        items={[
          { value: "lp", label: "Lightly Played" },
          { value: "nm", label: "Near Mint" },
        ]}
        onValueChange={onValueChange}
      />,
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
          { value: "activity", label: "Activity", content: <div>Activity content</div> },
        ]}
      />,
    );

    expect(screen.getByRole("tab", { name: "Summary" })).toBeTruthy();
    expect(screen.getByText("Summary content")).toBeTruthy();
  });

  it("renders action tabs with a scroll-stable panel frame", () => {
    const markup = renderToString(
      <ActionTabs
        items={[
          { value: "listings", label: "Listings", content: <div>Listings content</div> },
          { value: "offers", label: "Offers", content: <div>Offers content</div> },
        ]}
      />,
    );

    expect(markup).toContain("[overflow-anchor:none]");
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

  it("shows tooltips from focus", async () => {
    render(
      <Tooltip content="Margin includes shipping credit.">
        <button type="button">Margin help</button>
      </Tooltip>,
    );

    fireEvent.focus(screen.getByRole("button", { name: "Margin help" }));

    expect(await screen.findByText("Margin includes shipping credit.")).toBeTruthy();
  });
});
