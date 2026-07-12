import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act, useState } from "react";
import userEvent from "@testing-library/user-event";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as designSystem from "../index";
import {
  ActorIdentityCue,
  AccountMenu,
  ActionBar,
  ActionRow,
  ActionStack,
  AppliedFilterChips,
  BulkActionBar,
  BulkActionPanel,
  BulkActionSurface,
  Badge,
  Card,
  Button,
  CheckoutConfirmationPanel,
  CheckoutExpressActions,
  CheckoutFlowShell,
  CheckoutFormSection,
  CheckoutMobileSummaryDisclosure,
  CheckoutReadinessPrompt,
  CheckoutSavedInfoGroup,
  CheckoutSavedInfoRow,
  CheckoutStateNotice,
  CheckoutStickyActionBar,
  CheckoutSummaryPanel,
  Inline,
  KeyValueList,
  AccountReputationSummary,
  OrderProtectionBadge,
  ListingCard,
  TrustBadge,
  VerifiedAccountBadge,
  SecurePaymentCue,
  AccountTrustCard,
  PriceBreakdown,
  OrderProtectionModule,
  FilterArea,
  FilterBar,
  SavedSearchPrompt,
  SearchFilterPanel,
  SearchInput,
  MarketplaceFacetChoiceGroup,
  MarketplaceFacetRail,
  MarketplaceFilterBottomSheet,
  MarketplaceMobileFilterBar,
  MarketplaceCartLineItem,
  ListingPurchasePanel,
  MarketingImageHero,
  MarketingVisualCard,
  OrderIntentSummary,
  OfferCard,
  PaymentRecoveryPanel,
  ProductOptions,
  SearchControlBar,
  AccountCredibilityHeader,
  Select,
  Table,
  Textarea,
  TextInput,
  formatProductImageAltText,
  formatProductOptionsAriaLabel,
  productOptionsFromSummary,
  formatMarketplaceNumber,
  chaseTheme,
} from "../index";
import { minWidthQuery } from "../theme/tokens";

const listingCardLabels = {
  detailLinkLabel: "View details for this product",
  saveLabel: "Save this product",
  savedLabel: "Saved this product",
  watchingLabel: "Watching this product",
};

describe("design system marketplace patterns", () => {
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

    expect(Object.keys(designSystem).filter((exportName) => /^Ui[A-Z]/.test(exportName))).toEqual([]);
  });

  it("exposes the canonical commerce surface at the package root", () => {
    const canonicalCommerceExports = [
      "TrustBadge",
      "VerifiedAccountBadge",
      "AccountReputationSummary",
      "AccountTrustCard",
      "ListingCard",
      "MarketplaceCartLineItem",
      "SearchFilterPanel",
      "PriceBreakdown",
      "ListingPurchasePanel",
      "OrderProtectionModule",
      "OfferCard",
      "MarketplaceDashboardPanel",
      "formatMarketplaceNumber",
    ];

    for (const exportName of canonicalCommerceExports) {
      expect(designSystem).toHaveProperty(exportName);
    }
  });

  it("drops the unified commerce duplicates from the package root", () => {
    const removedDuplicateExports = ["MarketplaceMetricStrip", "OrderSummary"];

    for (const exportName of removedDuplicateExports) {
      expect(designSystem).not.toHaveProperty(exportName);
    }
  });

  it("layers dropdown and popover panels above modal panels", () => {
    const layers = chaseTheme.zIndex;

    expect(Number(layers.dropdown)).toBeGreaterThan(Number(layers.modal));
    expect(Number(layers.popover)).toBeGreaterThan(Number(layers.modal));
    expect(Number(layers.toast)).toBeGreaterThan(Number(layers.popover));
  });

  it("keeps key-value facts visually local by default", () => {
    const markup = renderToString(
      <KeyValueList
        density="compact"
        items={[
          { key: "Card number", value: "LP-2026-05-31" },
          { key: "Card name", value: "Chase Sets Launch Proof Card" },
        ]}
      />,
    );

    expect(markup).toContain("sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]");
    expect(markup).toContain("text-left");
    expect(markup).toContain("break-words");
    expect(markup).not.toContain("justify-between");
    expect(markup).not.toContain("text-right");
  });

  it("treats legacy key-value density aliases as comfortable", () => {
    const items = [{ key: "Subtotal", value: "$12.00" }];
    const comfortableMarkup = renderToString(<KeyValueList density="comfortable" items={items} />);
    const defaultAliasMarkup = renderToString(<KeyValueList density="default" items={items} />);
    const regularAliasMarkup = renderToString(<KeyValueList density="regular" items={items} />);

    expect(defaultAliasMarkup).toBe(comfortableMarkup);
    expect(regularAliasMarkup).toBe(comfortableMarkup);
    expect(comfortableMarkup).toContain("pb-3");
  });

  it("preserves explicit split key-value rows for compact summaries", () => {
    const markup = renderToString(<KeyValueList layout="split" items={[{ key: "Subtotal", value: "$12.00" }]} />);

    expect(markup).toContain("justify-between");
    expect(markup).toContain("text-right");
    expect(markup).not.toContain("sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]");
  });

  it("renders key-value facts as a dense grid when requested", () => {
    const markup = renderToString(
      <KeyValueList
        layout="grid"
        items={[
          { key: "Rarity", value: "Launch Proof" },
          { key: "Language", value: "English" },
        ]}
      />,
    );

    expect(markup).toContain("sm:grid-cols-2");
    expect(markup).toContain("text-left");
    expect(markup).toContain("break-words");
  });

  it("renders primitive components on the server", () => {
    const markup = renderToString(
      <Card>
        <div>
          <h2>Listing tools</h2>
          <Button>Save</Button>
          <Badge tone="success">Ready</Badge>
          <TextInput label="Card" hideLabel defaultValue="Charizard" />
          <Textarea label="Seller note" hideLabel defaultValue="Seller note" />
        </div>
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

  it("opens desktop account menus from native click activation", async () => {
    const onColorModeChange = vi.fn();

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
          preferences={{ colorMode: "system", onColorModeChange }}
          signOutFormId="account-menu-sign-out"
          signOutLabel="Sign Out"
        />
      </div>,
    );

    const trigger = screen.getByRole("button", { name: "Account menu" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    expect(await screen.findByRole("group", { name: "Color theme" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

    expect(onColorModeChange).toHaveBeenCalledWith("dark");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("respects controlled account menu open state", async () => {
    const onOpenChange = vi.fn();

    render(
      <div>
        <form id="account-menu-sign-out" action="/sign-out" method="post" />
        <AccountMenu
          open={false}
          onOpenChange={onOpenChange}
          accountName="Card Vault"
          roleName="Manager"
          userName="Alex Clerk"
          items={[{ key: "account", label: "Account", href: "/account", icon: "user" }]}
          signOutFormId="account-menu-sign-out"
          signOutLabel="Sign Out"
        />
      </div>,
    );

    const trigger = screen.getByRole("button", { name: "Account menu" });
    fireEvent.click(trigger);

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menuitem", { name: "Account" })).toBeNull();
  });

  it.each([
    ["desktop menu", true],
    ["mobile sheet", false],
  ])(
    "hydrates responsive account menus through the %s before exposing theme preferences",
    async (_label, isDesktop) => {
      const user = userEvent.setup();
      const previousMatchMedia = window.matchMedia;
      const onColorModeChange = vi.fn();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const menu = (
        <div>
          <form id="account-menu-sign-out" action="/sign-out" method="post" />
          <AccountMenu
            accountName="Card Vault"
            roleName="Manager"
            userName="Alex Clerk"
            items={[
              { key: "account", label: "Account", href: "/account", icon: "user" },
              { key: "wallet", label: "Wallet", href: "/account/settlement", icon: "wallet" },
              { key: "payouts", label: "Payouts", href: "/account/payouts", icon: "wallet" },
              { key: "offers", label: "Submitted Offers", href: "/account/offers/submitted", icon: "tag" },
              { key: "reviews", label: "Reviews", href: "/account/reviews", icon: "star" },
            ]}
            preferences={{ colorMode: "system", onColorModeChange }}
            signOutFormId="account-menu-sign-out"
            signOutLabel="Sign Out"
          />
        </div>
      );
      const container = document.createElement("div");
      let root: Root | undefined;

      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: vi.fn((query: string) => ({
          matches: query === minWidthQuery("md") ? isDesktop : false,
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(() => false),
        })),
      });

      container.innerHTML = renderToString(menu);
      document.body.appendChild(container);

      try {
        await act(async () => {
          root = hydrateRoot(container, menu);
        });

        expect(
          consoleError.mock.calls.some((call) =>
            call.some((entry) => {
              const message = String(entry).toLowerCase();

              return message.includes("hydration") || message.includes("react error #418");
            }),
          ),
        ).toBe(false);

        const trigger = within(container).getByRole("button", { name: "Account menu" });
        await waitFor(() => {
          expect(trigger.getAttribute("aria-expanded")).toBe("false");
        });

        await user.click(trigger);

        const colorTheme = await screen.findByRole("group", { name: "Color theme" });
        expect(colorTheme).toBeTruthy();
        await user.click(within(colorTheme).getByRole("radio", { name: "Dark" }));

        expect(onColorModeChange).toHaveBeenCalledWith("dark");
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
      } finally {
        await act(async () => {
          root?.unmount();
        });
        container.remove();
        consoleError.mockRestore();

        if (previousMatchMedia) {
          Object.defineProperty(window, "matchMedia", {
            configurable: true,
            writable: true,
            value: previousMatchMedia,
          });
        } else {
          Reflect.deleteProperty(window, "matchMedia");
        }
      }
    },
  );

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
    expect(markup).not.toContain("srcset");
    expect(markup).not.toContain("sizes=");
  });

  it("wires marketing visual card srcset/sizes so narrower viewports request a smaller image", () => {
    const markup = renderToString(
      <MarketingVisualCard
        imageSrc="/assets/waitlist-panels.webp"
        imageSrcSet="/assets/waitlist-panels-600w.webp 600w, /assets/waitlist-panels-1080w.webp 1080w, /assets/waitlist-panels.webp 2172w"
        imageSizes="(min-width: 1024px) 50vw, 100vw"
        imageAlt="Sorted collectible inventory"
        imageWidth={1200}
        imageHeight={900}
        title="Move more inventory"
      />,
    );

    expect(markup).toContain(
      'srcSet="/assets/waitlist-panels-600w.webp 600w, /assets/waitlist-panels-1080w.webp 1080w, /assets/waitlist-panels.webp 2172w"',
    );
    expect(markup).toContain('sizes="(min-width: 1024px) 50vw, 100vw"');
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
    expect(markup).not.toContain("srcset");
    expect(markup).not.toContain("sizes=");
  });

  it("wires marketing hero srcset/sizes so mobile viewports request the narrower hero variant", () => {
    const markup = renderToString(
      <MarketingImageHero
        imageSrc="/assets/hero.webp"
        imageSrcSet="/assets/hero-800w.webp 800w, /assets/hero-1200w.webp 1200w, /assets/hero.webp 1731w"
        imageSizes="100vw"
        imageAlt="Cards ready to list"
        imageWidth={1600}
        imageHeight={1000}
        title="List cards without giving up margin"
      />,
    );

    expect(markup).toContain(
      'srcSet="/assets/hero-800w.webp 800w, /assets/hero-1200w.webp 1200w, /assets/hero.webp 1731w"',
    );
    expect(markup).toContain('sizes="100vw"');
  });

  it("surfaces the primary marketing highlight outside the md:hidden breakpoint so small screens see it", () => {
    const markup = renderToString(
      <MarketingImageHero
        imageSrc="/assets/hero.webp"
        imageAlt="Cards ready to list"
        density="compact"
        title="List cards without giving up margin"
        conversionPanel={<form aria-label="Early access form" />}
        highlights={[
          { label: "0% beta seller fees", value: "Keep 100% of the sale" },
          { label: "No seller processing fee", value: "$0 separate line" },
          { label: "Buyer totals", value: "Costs visible before payment" },
        ]}
      />,
    );

    expect(markup).toContain('md:hidden" aria-label="Marketing highlight">');
    expect(markup).toContain('hidden max-w-2xl grid-cols-3 gap-2 md:grid" aria-label="Marketing highlights">');
    expect(markup).toContain("0% beta seller fees");
    expect(markup).toContain("Keep 100% of the sale");
  });

  it("maps marketing hero legacy default density to comfortable", () => {
    const defaultAliasMarkup = renderToString(
      <MarketingImageHero imageSrc="/assets/hero.webp" imageAlt="Cards ready to list" density="default" title="Sell" />,
    );
    const comfortableMarkup = renderToString(
      <MarketingImageHero
        imageSrc="/assets/hero.webp"
        imageAlt="Cards ready to list"
        density="comfortable"
        title="Sell"
      />,
    );

    expect(defaultAliasMarkup).toBe(comfortableMarkup);
    expect(comfortableMarkup).toContain("min-h-[22rem]");
  });

  it("renders conversion-first marketplace listing signals", () => {
    const markup = renderToString(
      <ListingCard
        {...listingCardLabels}
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
        {...listingCardLabels}
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
        {...listingCardLabels}
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
        {...listingCardLabels}
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

  it("keeps linked search result detail targets separate from rail actions", () => {
    const { container } = render(
      <ListingCard
        {...listingCardLabels}
        detailLinkLabel="View details for Abra — Base Set 43 Standard Set Common"
        href="/items/abra"
        cardLayout="search-result"
        title="Abra"
        subtitle="Base Set 43 Standard Set Common"
        imageSrc="/assets/abra-224w.webp"
        imageAlt="Abra — Base Set 43 Standard Set Common"
        imageSlot="compact-product"
        primaryAction={
          <a href="/items/abra?market=buy" aria-label="Add product to Buy Cart">
            Buy
          </a>
        }
        secondaryAction={false}
      />,
    );

    const detailLink = screen.getByRole("link", { name: "View details for Abra — Base Set 43 Standard Set Common" });
    const heading = screen.getByRole("heading", { name: "Abra" });
    expect(detailLink.textContent).toBe("");
    expect(detailLink.getAttribute("href")).toBe("/items/abra");
    expect(detailLink.closest("h3")).toBeNull();
    expect(detailLink.parentElement?.contains(heading)).toBe(true);
    expect(heading.hasAttribute("aria-labelledby")).toBe(false);
    expect(screen.getByRole("img", { name: "Abra — Base Set 43 Standard Set Common" })).toBeTruthy();
    expect(detailLink.className).toContain("pointer-events-auto");
    expect(container.querySelector('article > a[href="/items/abra"]')).toBeNull();
    expect(screen.getByRole("link", { name: "Add product to Buy Cart" }).getAttribute("href")).toBe(
      "/items/abra?market=buy",
    );
  });

  it("uses consumer-provided accessible action labels", () => {
    const { rerender } = render(
      <ListingCard {...listingCardLabels} title="Abra" watching primaryAction={<Button>Buy now</Button>} />,
    );

    expect(screen.getByRole("button", { name: "Save this product" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Watching this product" })).toBeTruthy();

    rerender(<ListingCard {...listingCardLabels} title="Abra" saved primaryAction={<Button>Buy now</Button>} />);

    expect(screen.getByRole("button", { name: "Saved this product" })).toBeTruthy();
  });

  it("keeps loading-only fallback images out of the product-back preview layer", () => {
    const markup = renderToString(
      <ListingCard
        {...listingCardLabels}
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
        {...listingCardLabels}
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
        {...listingCardLabels}
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
        {...listingCardLabels}
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
        {...listingCardLabels}
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

  it("enforces one-primary-per-surface through the action-hierarchy helpers", () => {
    // The single-primary contract is enforceable, not just conventional: a guard
    // that scans any rendered surface for the contract attribute fails if more
    // than one primary action is present.
    function expectAtMostOnePrimary(markup: string) {
      const counts = [...markup.matchAll(/data-primary-action-count="(\d+)"/g)].map((match) => Number(match[1]));
      for (const count of counts) {
        expect(count).toBeLessThanOrEqual(1);
      }
    }

    const validRow = renderToString(
      <ActionRow primary={<Button>Check out</Button>} secondary={<Button tone="secondary">Keep shopping</Button>} />,
    );
    expect(validRow).toContain('data-primary-action-count="1"');
    expectAtMostOnePrimary(validRow);

    const validStack = renderToString(
      <ActionStack primary={<Button>Pay now</Button>} secondary={<Button tone="secondary">Back to cart</Button>} />,
    );
    expect(validStack).toContain('data-primary-action-count="1"');
    expectAtMostOnePrimary(validStack);

    // The guard catches a hand-rolled surface that stamps more than one primary.
    const twoPrimaries = renderToString(
      <div data-primary-action-count="2">
        <Button>Pay now</Button>
        <Button>Confirm</Button>
      </div>,
    );
    expect(() => expectAtMostOnePrimary(twoPrimaries)).toThrow();
  });

  it("surfaces an explicit account trust signal even when the seller is not verified", () => {
    const markup = renderToString(
      <ListingCard
        {...listingCardLabels}
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
          <Badge tone="success">Account</Badge>
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
    expect(markup).toContain("line-clamp-2");
    expect(markup).toContain("grid-cols-2 md:grid-cols-1");
    expect(markup).not.toContain("min-[420px]");
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

  it("renders Shopify-simple checkout shell primitives", () => {
    const items = [
      {
        id: "line_1",
        title: "Acerola's Mischief",
        subtitle: "Raw - Damaged",
        facts: ["Card Vault", "Ships Jun 16-19"],
        quantity: "1",
        price: "$25.99",
        image: { src: "/fake-cdn/assets/acerola.png", alt: "Acerola's Mischief card" },
      },
    ];
    const totals = [
      { label: "Subtotal", value: "$25.99" },
      { label: "Shipping", value: "$0.20" },
      { label: "Credit", value: "-$0.00", muted: true },
    ];
    const summary = (
      <CheckoutSummaryPanel
        title="Order summary"
        subtitle="1 item"
        status="Ready"
        statusTone="success"
        items={items}
        totals={totals}
        totalLabel="Total"
        total="$27.29"
        currency="USD"
        reassurance="Payment starts after final review."
        actions={<Button>Pay now</Button>}
      />
    );
    const markup = renderToString(
      <CheckoutFlowShell
        summaryLabel="Desktop checkout summary"
        mobileSummary={
          <CheckoutMobileSummaryDisclosure label="Order summary" collapsedSummary="1 item" total="$27.29">
            {summary}
          </CheckoutMobileSummaryDisclosure>
        }
        desktopSummary={summary}
        stickyAction={
          <CheckoutStickyActionBar
            totalLabel="Total"
            total="$27.29"
            context="1 item"
            primaryAction={<Button>Pay now</Button>}
            secondaryAction={<Button tone="secondary">Back</Button>}
          />
        }
        main={
          <div>
            <CheckoutExpressActions
              label="Express checkout"
              actions={
                <>
                  <Button>Shop Pay</Button>
                  <Button tone="secondary">Google Pay</Button>
                </>
              }
            />
            <CheckoutSavedInfoGroup title="Saved checkout details">
              <CheckoutSavedInfoRow
                icon="home"
                label="Ship to"
                value="Todd Skelton"
                supportingText="Wichita, KS"
                action={<Button tone="ghost">Edit</Button>}
              />
              <CheckoutSavedInfoRow icon="creditCard" label="Payment" value="Mastercard ... 2738" status="Ready" />
              <CheckoutSavedInfoRow icon="wallet" label="Payout" value="Bank account ready" status="Ready" />
            </CheckoutSavedInfoGroup>
            <CheckoutSummaryPanel
              title="Sell list summary"
              subtitle="2 cards"
              status="Payout ready"
              statusTone="success"
              items={[
                {
                  id: "sell_line_1",
                  title: "Pikachu Jungle",
                  subtitle: "Lightly Played",
                  facts: ["Quantity 1", "Condition review before payout"],
                  price: "$18.40",
                },
              ]}
              totals={[{ label: "Estimated offer", value: "$18.40" }]}
              totalLabel="Estimated payout"
              total="$18.40"
            />
            <CheckoutFormSection title="Delivery" description="Enter where this should ship.">
              <TextInput label="Address" defaultValue="3354 Brush Creek Court" />
            </CheckoutFormSection>
            <CheckoutReadinessPrompt
              tone="warning"
              title="Save $4.20 by changing fulfillment"
              description="This happens before checkout starts."
              facts={[{ label: "Current allocation", value: "Valid" }]}
              action={<Button>Use savings</Button>}
              secondaryAction={<Button tone="secondary">Keep current</Button>}
            />
            <CheckoutStateNotice
              tone="danger"
              title="Address needs attention"
              description="Update the postal code before payment."
            />
            <CheckoutConfirmationPanel
              title="Order received"
              description="A receipt was sent."
              referenceLabel="Order"
              referenceValue="ORD-1001"
              totalLabel="Total"
              total="$27.29"
              nextSteps={[
                { title: "History", description: "Order is in account history.", icon: "book" },
                { title: "Support", description: "Use ORD-1001 for help.", icon: "help" },
              ]}
              actions={<Button>View order</Button>}
            />
          </div>
        }
      />,
    );

    expect(markup).toContain("Desktop checkout summary");
    expect(markup).toContain("Order summary");
    expect(markup).toContain("Acerola&#x27;s Mischief");
    expect(markup).toContain('src="/fake-cdn/assets/acerola.png"');
    expect(markup).toContain("Payment starts after final review.");
    expect(markup).toContain("Saved checkout details");
    expect(markup).toContain("Sell list summary");
    expect(markup).toContain("Estimated payout");
    expect(markup).toContain("Bank account ready");
    expect(markup).toContain("Save $4.20 by changing fulfillment");
    expect(markup).toContain("This happens before checkout starts.");
    expect(markup).toContain("Address needs attention");
    expect(markup).toContain("Order received");
    expect(markup).toContain('data-primary-action-count="1"');
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
        primaryActions={
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
});
