import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Form,
  Banner,
  Badge,
  BrandLink,
  Button,
  Checkbox,
  CheckboxGroup,
  ChaseRoot,
  Cluster,
  Container,
  DiscountValue,
  Grid,
  Heading,
  HiddenInput,
  HoneypotInput,
  Inline,
  LinkButton,
  LinkText,
  ListingCard,
  List,
  MarketingImageHero,
  MobileStickyBar,
  MobileStickyInset,
  NativeSelect,
  OfferCard,
  Page,
  PageHeader,
  PageSection,
  PromoBar,
  SegmentedControl,
  SkipLink,
  Stack,
  Surface,
  PriceBreakdown,
  Table,
  Text,
  TextInput,
  ToneIcon,
  useMediaQuery,
  type PromoBarMessage,
} from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import prelaunchHeroUrl from "./assets/chase-sets-prelaunch-hero.webp?url";
import prelaunchHero800wUrl from "./assets/chase-sets-prelaunch-hero-800w.webp?url";
import prelaunchHero1200wUrl from "./assets/chase-sets-prelaunch-hero-1200w.webp?url";
import pikachuIllustrationRareUrl from "./assets/pikachu-illustration-rare-preview.webp?url";
import { trackWaitlistEvent } from "./analytics";
import {
  checkoutFeeTranslationValues,
  fallbackCheckoutFeePreview,
  type CheckoutFeePreview,
} from "./checkout-fee-preview";
import { FeeCalculatorSection, type PublicMarketplaceFeeSchedule } from "./fee-comparison-calculator";
import {
  landingExperimentVariantForIntent,
  landingExperimentVariants,
  resolveLandingIntent,
  type LandingExperimentVariant,
  type LandingIntent,
} from "./landing-experiment";
import { launchTimeline } from "./launch-config";
import { publicPresenceT as t } from "./public-presence-translator";
import { sellerToolsClaimStatus } from "./seller-tools-claims";

export type WaitlistActionData = Readonly<{ status: "error"; message: string }> | null;

export type WaitlistPageSource = Readonly<{
  pagePath: string;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  /** Referral code (referring signup's id) read from an inbound `?ref=` link, if any. */
  referredBySignupId: string | null;
}>;

const roleItems = [
  { value: "both", label: t("publicPresence.waitlist.role.both") },
  { value: "buy", label: t("publicPresence.waitlist.role.buy") },
  { value: "sell", label: t("publicPresence.waitlist.role.sell") },
];

const interestItems = [
  {
    value: "low-sales-fees",
    label: t("publicPresence.waitlist.interest.lowSellerFees"),
    description: t("publicPresence.waitlist.interest.lowSellerFees.description"),
  },
  {
    value: "bulk-listing",
    label: t("publicPresence.waitlist.interest.bulkListing"),
    description: t("publicPresence.waitlist.interest.bulkListing.description"),
  },
  {
    value: "set-completion",
    label: t("publicPresence.waitlist.interest.setCompletion"),
    description: t("publicPresence.waitlist.interest.setCompletion.description"),
  },
  {
    value: "pricing-tools",
    label: t("publicPresence.waitlist.interest.pricingTools"),
    description: t("publicPresence.waitlist.interest.pricingTools.description"),
  },
  {
    value: "efficient-shipping",
    label: t("publicPresence.waitlist.interest.efficientShipping"),
    description: t("publicPresence.waitlist.interest.efficientShipping.description"),
  },
];

const interestSelectItems = interestItems.map(({ value, label }) => ({ value, label }));

// Wave-1 cohort quality fields, captured only from sell/both-intent signups.
// See bounded-contexts/public-presence/features/waitlist/domain/common.ts
// for the canonical WaitlistGame/WaitlistInventorySize enums this mirrors.
export const gameItems = [
  { value: "pokemon", label: t("publicPresence.waitlist.game.pokemon") },
  { value: "magic-the-gathering", label: t("publicPresence.waitlist.game.magicTheGathering") },
  { value: "yu-gi-oh", label: t("publicPresence.waitlist.game.yuGiOh") },
  { value: "disney-lorcana", label: t("publicPresence.waitlist.game.disneyLorcana") },
  { value: "one-piece-card-game", label: t("publicPresence.waitlist.game.onePieceCardGame") },
];

export const inventorySizeItems = [
  { value: "under_100", label: t("publicPresence.waitlist.inventorySize.under100") },
  { value: "100_to_500", label: t("publicPresence.waitlist.inventorySize.100to500") },
  { value: "500_to_2000", label: t("publicPresence.waitlist.inventorySize.500to2000") },
  { value: "2000_plus", label: t("publicPresence.waitlist.inventorySize.2000plus") },
];

// The named game roster: campaign-linkable per-game entry points in the
// canonical WAITLIST_GAMES order. Roster labels are campaign copy (Pokemon
// leads with the EN & Japanese differentiator), distinct from the shorter
// waitlist form labels above.
const gameRosterItems = [
  { value: "pokemon", label: t("publicPresence.home.gameRoster.game.pokemon") },
  { value: "magic-the-gathering", label: t("publicPresence.home.gameRoster.game.magicTheGathering") },
  { value: "yu-gi-oh", label: t("publicPresence.home.gameRoster.game.yuGiOh") },
  { value: "one-piece-card-game", label: t("publicPresence.home.gameRoster.game.onePieceCardGame") },
  { value: "disney-lorcana", label: t("publicPresence.home.gameRoster.game.disneyLorcana") },
];

/**
 * Normalizes an inbound `?game=` slug (game roster tile click or a per-game
 * campaign link) to the five supported games; anything else is treated as
 * absent so an arbitrary query value never reaches the signup form.
 */
export function normalizeSelectedGame(value: string | null | undefined): string | null {
  return value && gameItems.some((item) => item.value === value) ? value : null;
}

function selectedGameLabel(selectedGame: string | null) {
  return gameItems.find((item) => item.value === selectedGame)?.label ?? null;
}

/**
 * Builds a game-tile href that lands on the hero signup form with
 * `?game=<slug>` while preserving the visitor's existing query string
 * (UTM attribution, referral code) from the loader-captured page path.
 */
function gameRosterHref(pagePath: string, game: string) {
  const queryIndex = pagePath.indexOf("?");
  const params = new URLSearchParams(queryIndex >= 0 ? pagePath.slice(queryIndex + 1) : "");
  params.set("game", game);
  return `/?${params.toString()}#waitlist-form`;
}

type WaitlistMarketplaceIntent = LandingIntent;
type WaitlistInterest = "low-sales-fees" | "bulk-listing" | "set-completion" | "pricing-tools" | "efficient-shipping";

type WaitlistIntent = Readonly<{
  role: WaitlistMarketplaceIntent;
  interest: WaitlistInterest;
}>;

const defaultIntent: WaitlistIntent = {
  role: "both",
  interest: "low-sales-fees",
};

const LandingExperimentVariantContext = createContext<LandingExperimentVariant>(
  landingExperimentVariants.sellerFirstV1,
);

function useLandingExperimentVariant() {
  return useContext(LandingExperimentVariantContext);
}

const sellerIntent: WaitlistIntent = {
  role: "sell",
  interest: "low-sales-fees",
};

const buyerIntent: WaitlistIntent = {
  role: "buy",
  interest: "set-completion",
};

const heroIntentItems = [
  { value: "sell", label: t("publicPresence.waitlist.heroIntent.sell"), icon: "store" as const },
  { value: "buy", label: t("publicPresence.waitlist.heroIntent.buy"), icon: "cart" as const },
  { value: "both", label: t("publicPresence.waitlist.heroIntent.both"), icon: "users" as const },
];

function heroIntentValue(intent: WaitlistIntent) {
  if (intent.role === "sell") {
    return "sell";
  }

  if (intent.role === "buy") {
    return "buy";
  }

  return "both";
}

function resolveHeroIntent(value: string): WaitlistIntent {
  if (value === "sell") {
    return sellerIntent;
  }

  if (value === "buy") {
    return buyerIntent;
  }

  return defaultIntent;
}

function resolveInitialHeroIntent(source: WaitlistPageSource): WaitlistIntent {
  const pageUrl = new URL(source.pagePath, "https://chasesets.test");
  return resolveHeroIntent(resolveLandingIntent({ ...source, intent: pageUrl.searchParams.get("intent") }));
}

// LinkText renders a bare, unpadded anchor (23-24px tall) that falls short of
// the 44px touch-target guideline on coarse pointers. Wrapping its label in a
// padded inline-flex span grows the anchor's own box (inline-flex sizes to its
// tallest child) without a DS-wide LinkText change or any visible difference
// for mouse/trackpad pointers. Sized via inline style gated on the DS
// useMediaQuery hook rather than a CSS media-query class, since design-system
// governance (routeLocalClassName) disallows raw Tailwind classes on host
// elements in bounded-context UI outside the design-system package.
const coarsePointerTouchTargetStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 44,
  minWidth: 44,
  paddingLeft: 8,
  paddingRight: 8,
  paddingTop: 8,
  paddingBottom: 8,
};

function CoarsePointerLinkLabel({ children }: { children: ReactNode }) {
  const hasCoarsePointer = useMediaQuery("(pointer: coarse)");
  return <span style={hasCoarsePointer ? coarsePointerTouchTargetStyle : undefined}>{children}</span>;
}

// The fee-comparison Table's metric column ("Marketplace fee", "Per-order and
// payment fee", ...) contains an 11-character unbreakable word ("Marketplace")
// that alone exceeds the column's fair share of a 375px viewport, forcing
// the table wrapper's in-container horizontal scroll even at compact density.
// Constraining the label to a narrow column and allowing mid-word breaks lets
// it wrap onto two lines instead, per the #5620 fee-table fit fallback ruling
// (wrap the metric labels before any font-size reduction). Inline style for
// the same routeLocalClassName reason as CoarsePointerLinkLabel above.
const feeTableMetricLabelStyle: CSSProperties = {
  display: "block",
  maxWidth: "2.75rem",
  hyphens: "auto",
  overflowWrap: "break-word",
};

function FeeTableMetricLabel({ children }: { children: ReactNode }) {
  return (
    <span style={feeTableMetricLabelStyle} lang="en">
      {children}
    </span>
  );
}

const policyLinks = [
  { href: "/help", label: t("publicPresence.nav.help") },
  { href: "/terms", label: t("publicPresence.nav.terms") },
  { href: "/privacy", label: t("publicPresence.nav.privacy") },
  { href: "/refunds-and-returns", label: t("publicPresence.nav.refunds") },
  { href: "/order-protection", label: t("publicPresence.nav.buyerProtection") },
  { href: "/sales-fees", label: t("publicPresence.nav.sellerFees") },
  { href: "/founders", label: t("publicPresence.nav.foundersTerms") },
];

function trackCtaClick(
  placement: string,
  target: string,
  variant: LandingExperimentVariant = landingExperimentVariants.sellerFirstV1,
) {
  trackWaitlistEvent("cta_clicked", {
    section: placement,
    target,
    variant,
  });
}

function useLandingSectionViewTracking(variant: LandingExperimentVariant) {
  const viewedSections = useRef(new Set<string>());

  useEffect(() => {
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      return undefined;
    }

    const sections = document.querySelectorAll<HTMLElement>("[data-public-presence-section]");
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const section = entry.target.getAttribute("data-public-presence-section");
          if (!section || viewedSections.current.has(section) || !entry.isIntersecting) {
            return;
          }
          viewedSections.current.add(section);
          trackWaitlistEvent("section_viewed", {
            section,
            variant,
          });
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.45 },
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [variant]);
}

function DiscordInviteLink({
  href,
  section = "final_cta",
  variant,
}: {
  href: string;
  section?: string;
  variant?: LandingExperimentVariant;
}) {
  const contextVariant = useLandingExperimentVariant();
  const landingExperimentVariant = variant ?? contextVariant;

  return (
    <LinkButton
      href={href}
      tone="secondary"
      size="lg"
      leadingIcon="message"
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => trackCtaClick(section, "discord", landingExperimentVariant)}
    >
      {t("publicPresence.home.discordCta")}
    </LinkButton>
  );
}

function BadgeRow({ children }: { children: ReactNode }) {
  return <Inline gap={1}>{children}</Inline>;
}

function usePromoBarMessages() {
  const [messages, setMessages] = useState<PromoBarMessage[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/public-presence/promo-bar-messages", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((body: { items?: readonly Record<string, unknown>[] }) => {
        if (cancelled || !Array.isArray(body.items)) {
          return;
        }

        setMessages(
          body.items.map((message) => ({
            id: String(message.id),
            title: String(message.title ?? ""),
            description: typeof message.description === "string" ? message.description : null,
            href: typeof message.href === "string" ? message.href : null,
            linkLabel: typeof message.link_label === "string" ? message.link_label : null,
            tone:
              message.tone === "success" || message.tone === "warning" || message.tone === "info"
                ? message.tone
                : "info",
          })),
        );
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  return messages;
}

function useWaitlistCounterDisplay() {
  const [displayCount, setDisplayCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/public-presence/waitlist/count", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { displayCount?: number | null } | null) => {
        if (cancelled || !body) {
          return;
        }

        setDisplayCount(typeof body.displayCount === "number" ? body.displayCount : null);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  return displayCount;
}

export function PublicPresencePageShell({
  children,
  landingExperimentVariant = landingExperimentVariants.sellerFirstV1,
}: {
  children: ReactNode;
  landingExperimentVariant?: LandingExperimentVariant;
}) {
  const promoBarMessages = usePromoBarMessages();

  return (
    <LandingExperimentVariantContext.Provider value={landingExperimentVariant}>
      <ChaseRoot colorMode="system" linkComponent={RouterLinkAdapter}>
        <SkipLink />
        <MobileStickyInset>
          <Container width="wide">
            <Stack gap={4}>
              <PromoBar messages={promoBarMessages} />
              <Surface element="nav" tone="subtle" padding={2}>
                <Cluster gap={2}>
                  <Inline gap={3} align="center">
                    <BrandLink label={t("publicPresence.brand")} />
                  </Inline>
                  <LinkButton
                    href="/#waitlist-form"
                    tone="primary"
                    size="sm"
                    leadingIcon="rocket"
                    onClick={() => trackCtaClick("nav", "waitlist_form", landingExperimentVariant)}
                  >
                    {t("publicPresence.nav.waitlist")}
                  </LinkButton>
                </Cluster>
              </Surface>
              <main id="main-content">{children}</main>
              <Surface element="footer" tone="subtle">
                <Stack gap={3}>
                  <Text weight="semibold">{t("publicPresence.footer.title")}</Text>
                  <Inline gap={3}>
                    {policyLinks.map((link) => (
                      <LinkText key={link.href} href={link.href}>
                        <CoarsePointerLinkLabel>{link.label}</CoarsePointerLinkLabel>
                      </LinkText>
                    ))}
                    <LinkText href="/contact">
                      <CoarsePointerLinkLabel>{t("publicPresence.nav.contact")}</CoarsePointerLinkLabel>
                    </LinkText>
                  </Inline>
                  <Text size="sm" tone="secondary">
                    {t("publicPresence.footer.description")}
                  </Text>
                </Stack>
              </Surface>
            </Stack>
          </Container>
        </MobileStickyInset>
        <MobileStickyWaitlistCta landingExperimentVariant={landingExperimentVariant} />
      </ChaseRoot>
    </LandingExperimentVariantContext.Provider>
  );
}

function MobileStickyWaitlistCta({ landingExperimentVariant }: { landingExperimentVariant: LandingExperimentVariant }) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      return undefined;
    }

    const heroForm = document.getElementById("waitlist-form");
    if (!heroForm) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(!entry?.isIntersecting);
      },
      { threshold: 0.08 },
    );

    observer.observe(heroForm);
    return () => observer.disconnect();
  }, []);

  if (!isVisible) {
    return null;
  }

  return (
    <MobileStickyBar>
      <Container width="wide">
        <Cluster gap={2}>
          <Text size="sm" weight="semibold">
            {t("publicPresence.home.stickyCta.label")}
          </Text>
          <LinkButton
            href="#waitlist-form-final"
            tone="primary"
            size="sm"
            block
            leadingIcon="rocket"
            onClick={() => trackCtaClick("mobile_sticky", "waitlist_form_final", landingExperimentVariant)}
          >
            {t("publicPresence.home.stickyCta.action")}
          </LinkButton>
        </Cluster>
      </Container>
    </MobileStickyBar>
  );
}

export function PublicPresenceHomePage({
  actionData,
  discordInviteUrl,
  source,
  selectedGame: selectedGameInput = null,
  checkoutFeePreview = fallbackCheckoutFeePreview,
  feeSchedule = null,
}: {
  actionData: WaitlistActionData;
  discordInviteUrl?: string | null;
  source: WaitlistPageSource;
  /** Raw `?game=` slug from the loader (game roster tile / per-game campaign link); normalized here. */
  selectedGame?: string | null;
  /** Live buyer-side checkout processing presentation from the loader; falls back to the compiled launch terms. */
  checkoutFeePreview?: CheckoutFeePreview;
  /**
   * Live standard fee schedule from the whitelisted public policy read
   * (loader-provided). Null hides the calculator — its Chase Sets numbers
   * are truth-gated and never hardcoded.
   */
  feeSchedule?: PublicMarketplaceFeeSchedule | null;
}) {
  const [intent, setIntent] = useState<WaitlistIntent>(() => resolveInitialHeroIntent(source));
  const landingExperimentVariant = landingExperimentVariantForIntent(heroIntentValue(intent));
  const waitlistCounterDisplay = useWaitlistCounterDisplay();
  const selectedGame = normalizeSelectedGame(selectedGameInput);

  useEffect(() => {
    trackWaitlistEvent("landing_page_view", {
      page_path: source.pagePath,
      utm_source: source.utmSource,
      utm_medium: source.utmMedium,
      utm_campaign: source.utmCampaign,
      variant: landingExperimentVariant,
    });
  }, [source]);

  useEffect(() => {
    // Success never lands here: the route action redirects to /welcome on a
    // committed signup, so this page only ever sees the error outcome (the
    // form stays put so the visitor can correct and resubmit).
    if (actionData?.status === "error") {
      trackWaitlistEvent("waitlist_signup_failed", {
        page_path: source.pagePath,
        role: intent.role,
        interest: intent.interest,
        variant: landingExperimentVariant,
      });
    }
  }, [actionData, intent, landingExperimentVariant, source.pagePath]);

  useLandingSectionViewTracking(landingExperimentVariant);

  return (
    <PublicPresencePageShell landingExperimentVariant={landingExperimentVariant}>
      <Page>
        <Stack gap={2} data-public-presence-section="hero">
          <MarketingImageHero
            imageSrc={prelaunchHeroUrl}
            imageSrcSet={`${prelaunchHero800wUrl} 800w, ${prelaunchHero1200wUrl} 1200w, ${prelaunchHeroUrl} 1731w`}
            imageSizes="100vw"
            imageAlt={t("publicPresence.home.heroImageAlt")}
            imagePosition="center"
            imageLoading="eager"
            imageDecoding="async"
            imageFetchPriority="high"
            imageWidth={1600}
            imageHeight={1000}
            density="compact"
            eyebrow={
              landingExperimentVariant === landingExperimentVariants.sellerFirstV2
                ? t("publicPresence.home.buyerHero.eyebrow")
                : t("publicPresence.home.eyebrow")
            }
            title={
              landingExperimentVariant === landingExperimentVariants.sellerFirstV2
                ? t("publicPresence.home.buyerHero.title")
                : t("publicPresence.home.title")
            }
            description={
              landingExperimentVariant === landingExperimentVariants.sellerFirstV2
                ? t("publicPresence.home.buyerHero.description")
                : t("publicPresence.home.description")
            }
            highlights={[
              {
                label: t(
                  landingExperimentVariant === landingExperimentVariants.sellerFirstV2
                    ? "publicPresence.home.buyerHero.highlight.deliveredTotals.label"
                    : "publicPresence.home.heroHighlight.offers.label",
                ),
                value: t(
                  landingExperimentVariant === landingExperimentVariants.sellerFirstV2
                    ? "publicPresence.home.buyerHero.highlight.deliveredTotals.value"
                    : "publicPresence.home.heroHighlight.offers.value",
                ),
              },
              {
                label: t(
                  landingExperimentVariant === landingExperimentVariants.sellerFirstV2
                    ? "publicPresence.home.buyerHero.highlight.shippingCredit.label"
                    : "publicPresence.home.heroHighlight.lowValue.label",
                ),
                value: t(
                  landingExperimentVariant === landingExperimentVariants.sellerFirstV2
                    ? "publicPresence.home.buyerHero.highlight.shippingCredit.value"
                    : "publicPresence.home.heroHighlight.lowValue.value",
                ),
              },
              {
                label: t(
                  landingExperimentVariant === landingExperimentVariants.sellerFirstV2
                    ? "publicPresence.home.buyerHero.highlight.setCompletion.label"
                    : "publicPresence.home.heroHighlight.launch.label",
                ),
                value: t(
                  landingExperimentVariant === landingExperimentVariants.sellerFirstV2
                    ? "publicPresence.home.buyerHero.highlight.setCompletion.value"
                    : "publicPresence.home.heroHighlight.launch.value",
                ),
              },
            ]}
            conversionPanel={
              <WaitlistSignupPanel
                actionData={actionData}
                intent={intent}
                onIntentChange={setIntent}
                source={source}
                panelId="waitlist-form"
                variant="hero"
                waitlistCounterDisplay={waitlistCounterDisplay}
                selectedGame={selectedGame}
                landingExperimentVariant={landingExperimentVariant}
              />
            }
          />
        </Stack>

        <GameRosterSection pagePath={source.pagePath} selectedGame={selectedGame} />

        <OpenOffersSection />

        <SellerToolsSection />

        <FeeComparisonSection />

        <FeeCalculatorSection schedule={feeSchedule} />

        <FoundersOfferSection />

        <LaunchTimelineSection />

        <ProductSignalPreview checkoutFeePreview={checkoutFeePreview} />

        <FounderStorySection discordInviteUrl={discordInviteUrl} />

        <FinalCtaSection
          actionData={actionData}
          discordInviteUrl={discordInviteUrl}
          intent={intent}
          onIntentChange={setIntent}
          source={source}
          selectedGame={selectedGame}
          landingExperimentVariant={landingExperimentVariant}
        />

        <FaqPreview checkoutFeePreview={checkoutFeePreview} />
      </Page>
    </PublicPresencePageShell>
  );
}

// The named game roster strip: the first scannable proof of scope under the
// hero. Each tile is a campaign-linkable per-game entry point
// (`/?game=<slug>#waitlist-form`) that preserves UTM/referral attribution and
// prefills the signup form's game selection. Truth-gated: names exactly the
// five supported games; the copy line is the approved catalog claim.
function GameRosterSection({ pagePath, selectedGame }: { pagePath: string; selectedGame: string | null }) {
  const landingExperimentVariant = useLandingExperimentVariant();

  return (
    <PageSection
      data-public-presence-section="game_roster"
      title={t("publicPresence.home.gameRoster.title")}
      description={t("publicPresence.home.gameRoster.description")}
    >
      <Grid columns={{ base: 1, sm: 2, lg: 5 }} gap={3}>
        {gameRosterItems.map((game) => (
          <LinkButton
            key={game.value}
            href={gameRosterHref(pagePath, game.value)}
            tone={selectedGame === game.value ? "primary" : "secondary"}
            size="lg"
            block
            onClick={() => trackCtaClick("game_roster", game.value, landingExperimentVariant)}
          >
            {game.label}
          </LinkButton>
        ))}
      </Grid>
    </PageSection>
  );
}

// The "everywhere else" card describes the generic pattern of buy/sell social
// groups (unlisted, unprotected, seller-hunts-a-stranger), not any single
// named platform. Unlike the fee-comparison surfaces (which name TCGplayer
// and eBay per the ratified competitor-naming decision), there is no single
// platform to name here.
function OpenOffersSection() {
  return (
    <PageSection
      data-public-presence-section="open_offers"
      title={t("publicPresence.home.openOffers.title")}
      description={t("publicPresence.home.openOffers.description")}
    >
      <Grid columns={{ base: 1, lg: 2 }} gap={4}>
        <Surface tone="subtle" elevated>
          <Stack gap={3}>
            <BadgeRow>
              <Badge tone="warning">{t("publicPresence.home.openOffers.before.badge")}</Badge>
            </BadgeRow>
            <Heading level={3}>{t("publicPresence.home.openOffers.before.title")}</Heading>
            <Text tone="secondary">{t("publicPresence.home.openOffers.before.description")}</Text>
            <List
              items={[
                t("publicPresence.home.openOffers.before.point.post"),
                t("publicPresence.home.openOffers.before.point.replies"),
                t("publicPresence.home.openOffers.before.point.payment"),
                t("publicPresence.home.openOffers.before.point.risk"),
              ]}
            />
          </Stack>
        </Surface>
        <Surface tone="subtle" elevated>
          <Stack gap={3}>
            <BadgeRow>
              <Badge tone="success">{t("publicPresence.home.openOffers.after.badge")}</Badge>
            </BadgeRow>
            <Heading level={3}>{t("publicPresence.home.openOffers.after.title")}</Heading>
            <Text tone="secondary">{t("publicPresence.home.openOffers.after.description")}</Text>
            <OfferCard
              title={t("publicPresence.home.openOffers.after.offerCard.title")}
              amount={t("publicPresence.home.openOffers.after.offerCard.amount")}
              status={t("publicPresence.home.openOffers.after.offerCard.status")}
              details={t("publicPresence.home.openOffers.after.offerCard.details")}
            />
            <List
              items={[
                t("publicPresence.home.openOffers.after.point.accept"),
                t("publicPresence.home.openOffers.after.point.checkout"),
                t("publicPresence.home.openOffers.after.point.record"),
              ]}
            />
          </Stack>
        </Surface>
      </Grid>
      <Grid columns={{ base: 1, md: 3 }} gap={3}>
        {[
          "publicPresence.home.openOffers.step.post",
          "publicPresence.home.openOffers.step.accept",
          "publicPresence.home.openOffers.step.checkout",
        ].map((key, index) => (
          <Surface key={key} elevated>
            <Stack gap={2}>
              <Badge tone="neutral">{index + 1}</Badge>
              <Text tone="secondary">{t(key)}</Text>
            </Stack>
          </Surface>
        ))}
      </Grid>
    </PageSection>
  );
}

// Seller-tools differentiator: the repricing engine and market analytics are
// real platform machinery, but their seller-facing controls are launch-gated.
// Keep every capability card explicitly future-facing until seller access is
// available; this section must never turn an implementation milestone into a
// claim of current product availability.
function SellerToolsSection() {
  const cards = [
    {
      capability: "repricing" as const,
      status: sellerToolsClaimStatus("repricing"),
      icon: "settings" as const,
      title: t("publicPresence.home.sellerTools.repricing.title"),
      description: t("publicPresence.home.sellerTools.repricing.description"),
      points: [
        t("publicPresence.home.sellerTools.repricing.point.anchor"),
        t("publicPresence.home.sellerTools.repricing.point.floor"),
        t("publicPresence.home.sellerTools.repricing.point.preview"),
      ],
    },
    {
      capability: "marketAnalytics" as const,
      status: sellerToolsClaimStatus("marketAnalytics"),
      icon: "chart" as const,
      title: t("publicPresence.home.sellerTools.market.title"),
      description: t("publicPresence.home.sellerTools.market.description"),
      points: [
        t("publicPresence.home.sellerTools.market.point.history"),
        t("publicPresence.home.sellerTools.market.point.collection"),
        t("publicPresence.home.sellerTools.market.point.fairness"),
      ],
    },
    {
      capability: "sellerScale" as const,
      status: sellerToolsClaimStatus("sellerScale"),
      icon: "dashboard" as const,
      title: t("publicPresence.home.sellerTools.scale.title"),
      description: t("publicPresence.home.sellerTools.scale.description"),
      points: [
        t("publicPresence.home.sellerTools.scale.point.inventory"),
        t("publicPresence.home.sellerTools.scale.point.bulk"),
        t("publicPresence.home.sellerTools.scale.point.api"),
      ],
    },
  ];

  return (
    <PageSection
      id="seller-tools"
      data-public-presence-section="seller_tools"
      title={t("publicPresence.home.sellerTools.title")}
      description={t("publicPresence.home.sellerTools.description")}
    >
      <Grid columns={{ base: 1, lg: 3 }} gap={4}>
        {cards.map((card) => (
          <Surface
            key={card.title}
            tone="subtle"
            elevated
            data-seller-tools-capability={card.capability}
            data-seller-tools-status={card.status}
          >
            <Stack gap={3}>
              <BadgeRow>
                <Badge tone={card.status === "live" ? "success" : "info"}>
                  {card.status === "live"
                    ? t("publicPresence.home.sellerTools.live")
                    : t("publicPresence.home.sellerTools.comingToBeta")}
                </Badge>
              </BadgeRow>
              <ToneIcon name={card.icon} tone="primary" size="lg" label={card.title} />
              <Heading level={3}>{card.title}</Heading>
              <Text tone="secondary">{card.description}</Text>
              <List items={card.points} />
            </Stack>
          </Surface>
        ))}
      </Grid>
      <Surface tone="subtle">
        <Inline gap={3} align="center">
          <ToneIcon name="rocket" tone="success" size="md" label={t("publicPresence.home.sellerTools.cta.title")} />
          <Stack gap={1}>
            <Heading level={3}>{t("publicPresence.home.sellerTools.cta.title")}</Heading>
            <Text size="sm" tone="secondary">
              {t("publicPresence.home.sellerTools.cta.description")}
            </Text>
          </Stack>
          <LinkButton
            href="#waitlist-form-final"
            tone="primary"
            onClick={() => trackCtaClick("seller_tools", "waitlist_form_final")}
          >
            {t("publicPresence.home.sellerTools.cta.action")}
          </LinkButton>
        </Inline>
      </Surface>
    </PageSection>
  );
}

// Fee-comparison sourcing: competitor figures use each marketplace's own
// published seller-fee schedule, applied to a $10.00 item price before
// shipping or tax, with cents rounded DOWN in each competitor's favor so the
// comparison is unimpeachable. Retrieved 2026-07-10, re-verified 2026-07-12.
// - TCGplayer: 10.75% Marketplace-seller commission (Level 1-4, effective
//   2026-02-10) + 2.5% + $0.30 transaction fee.
//   https://help.tcgplayer.com/hc/en-us/articles/201357836-TCGplayer-Fees
//   https://seller.tcgplayer.com/blog/important-changes-to-tcgplayer-direct-minimum-pricing-and-marketplace-fees
// - eBay: 13.25% trading-card final value fee (non-store rate, on sale
//   totals up to $7,500) + $0.30 per-order fee (orders of $10 or less).
//   https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=4822
// Competitors are named explicitly per the ratified competitor-naming
// decision (Todd, 2026-07-12): TCGplayer and eBay, here and on all
// downstream fee-comparison surfaces.
function FeeComparisonSection() {
  return (
    <PageSection
      data-public-presence-section="fee_comparison"
      title={t("publicPresence.home.sellerEconomics.comparison.title")}
      description={t("publicPresence.home.sellerEconomics.comparison.description")}
    >
      <Stack gap={3}>
        <Table
          density="compact"
          caption={t("publicPresence.home.sellerEconomics.comparison.caption")}
          columns={[
            <FeeTableMetricLabel>
              {t("publicPresence.home.sellerEconomics.comparison.column.metric")}
            </FeeTableMetricLabel>,
            t("publicPresence.home.sellerEconomics.comparison.column.chaseSets"),
            t("publicPresence.home.sellerEconomics.comparison.column.tcgplayer"),
            t("publicPresence.home.sellerEconomics.comparison.column.ebay"),
          ]}
          rows={[
            [
              <FeeTableMetricLabel>
                {t("publicPresence.home.sellerEconomics.comparison.row.marketplaceFee.label")}
              </FeeTableMetricLabel>,
              t("publicPresence.home.sellerEconomics.comparison.row.marketplaceFee.chaseSets"),
              t("publicPresence.home.sellerEconomics.comparison.row.marketplaceFee.tcgplayer"),
              t("publicPresence.home.sellerEconomics.comparison.row.marketplaceFee.ebay"),
            ],
            [
              <FeeTableMetricLabel>
                {t("publicPresence.home.sellerEconomics.comparison.row.perOrderFee.label")}
              </FeeTableMetricLabel>,
              t("publicPresence.home.sellerEconomics.comparison.row.perOrderFee.chaseSets"),
              t("publicPresence.home.sellerEconomics.comparison.row.perOrderFee.tcgplayer"),
              t("publicPresence.home.sellerEconomics.comparison.row.perOrderFee.ebay"),
            ],
            [
              <FeeTableMetricLabel>
                {t("publicPresence.home.sellerEconomics.comparison.row.youKeep.label")}
              </FeeTableMetricLabel>,
              <Badge tone="success" variant="solid">
                {t("publicPresence.home.sellerEconomics.comparison.row.youKeep.chaseSets")}
              </Badge>,
              t("publicPresence.home.sellerEconomics.comparison.row.youKeep.tcgplayer"),
              t("publicPresence.home.sellerEconomics.comparison.row.youKeep.ebay"),
            ],
          ]}
        />
        <Text size="sm" tone="tertiary">
          {t("publicPresence.home.sellerEconomics.comparison.sourceNote")}
        </Text>
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <PriceBreakdown
            title={t("publicPresence.home.sellerEconomics.math.title")}
            description={t("publicPresence.home.sellerEconomics.math.description")}
            lines={[
              {
                label: t("publicPresence.home.sellerEconomics.math.item"),
                value: t("publicPresence.home.sellerEconomics.math.item.value"),
              },
              {
                label: t("publicPresence.home.sellerEconomics.math.sellerFee"),
                value: t("publicPresence.home.sellerEconomics.math.sellerFee.value"),
              },
              {
                label: t("publicPresence.home.sellerEconomics.math.processingFee"),
                value: t("publicPresence.home.sellerEconomics.math.processingFee.value"),
              },
            ]}
            totalLabel={t("publicPresence.home.sellerEconomics.math.total")}
            total={t("publicPresence.home.sellerEconomics.math.total.value")}
            reassurance={t("publicPresence.home.sellerEconomics.math.reassurance")}
          />
          <PriceBreakdown
            title={t("publicPresence.home.sellerEconomics.math.graded.title")}
            description={t("publicPresence.home.sellerEconomics.math.graded.description")}
            lines={[
              {
                label: t("publicPresence.home.sellerEconomics.math.graded.item"),
                value: t("publicPresence.home.sellerEconomics.math.graded.item.value"),
              },
              {
                label: t("publicPresence.home.sellerEconomics.math.graded.sellerFee"),
                value: t("publicPresence.home.sellerEconomics.math.graded.sellerFee.value"),
              },
              {
                label: t("publicPresence.home.sellerEconomics.math.graded.processingFee"),
                value: t("publicPresence.home.sellerEconomics.math.graded.processingFee.value"),
              },
            ]}
            totalLabel={t("publicPresence.home.sellerEconomics.math.graded.total")}
            total={t("publicPresence.home.sellerEconomics.math.graded.total.value")}
            reassurance={t("publicPresence.home.sellerEconomics.math.graded.reassurance")}
          />
        </Grid>
      </Stack>
    </PageSection>
  );
}

// Founders offer module: replaces vague "Founding Account badge eligibility"
// copy with the concrete mechanics (cap, numbered badge, 60-day window).
// Cap is stated as a static number, not a live count: an "N of 500 founder
// numbers claimed" scarcity chip needs an activated-founders cohort counter
// that does not exist yet (only the waitlist signup counter is live, and
// that counts a different population -- signups, not activated founders).
// Ship the offer terms accurately now; wire the live counter once that
// cohort-counter machinery lands.
function FoundersOfferSection() {
  const landingExperimentVariant = useLandingExperimentVariant();

  return (
    <PageSection
      data-public-presence-section="founders_offer"
      title={t("publicPresence.home.foundersOffer.title")}
      description={t("publicPresence.home.foundersOffer.description")}
    >
      <Surface tone="subtle" elevated>
        <Stack gap={3}>
          <BadgeRow>
            <Badge tone="trust">{t("publicPresence.home.foundersOffer.badge")}</Badge>
          </BadgeRow>
          <List
            items={[
              t("publicPresence.home.foundersOffer.point.badge"),
              t("publicPresence.home.foundersOffer.point.window"),
              t("publicPresence.home.foundersOffer.point.expiry"),
              t("publicPresence.home.foundersOffer.point.community"),
              t("publicPresence.home.foundersOffer.point.input"),
            ]}
          />
          <Inline>
            <LinkButton
              href="/founders"
              tone="secondary"
              size="sm"
              onClick={() => trackCtaClick("founders_offer", "founders_terms", landingExperimentVariant)}
            >
              {t("publicPresence.home.foundersOffer.action")}
            </LinkButton>
          </Inline>
        </Stack>
      </Surface>
    </PageSection>
  );
}

// Launch timeline: answers "when can I use this?" with the one hard public
// date (September 1, 2026) and the beta-wave window before it. Truth gate:
// wave-to-wave progression is conditioned on ops metrics, so per-wave dates
// are never promised — the copy stays at "late July" resolution and only the
// public launch date is concrete. Both values interpolate from
// `launch-config.ts` so a date change is one edit.
function LaunchTimelineSection() {
  const landingExperimentVariant = useLandingExperimentVariant();

  const steps = [
    { key: "waves", badgeTone: "info" as const },
    { key: "founders", badgeTone: "trust" as const },
    { key: "launch", badgeTone: "success" as const },
  ];

  return (
    <PageSection
      data-public-presence-section="launch_timeline"
      title={t("publicPresence.home.launchTimeline.title")}
      description={t("publicPresence.home.launchTimeline.description", launchTimeline)}
    >
      <Grid columns={{ base: 1, md: 3 }} gap={4}>
        {steps.map((step) => (
          <Surface key={step.key} tone="subtle" elevated>
            <Stack gap={3}>
              <BadgeRow>
                <Badge tone={step.badgeTone}>
                  {t(`publicPresence.home.launchTimeline.step.${step.key}.badge`, launchTimeline)}
                </Badge>
              </BadgeRow>
              <Heading level={3}>
                {t(`publicPresence.home.launchTimeline.step.${step.key}.title`, launchTimeline)}
              </Heading>
              <Text tone="secondary">
                {t(`publicPresence.home.launchTimeline.step.${step.key}.description`, launchTimeline)}
              </Text>
              {step.key === "waves" ? (
                <List
                  items={[
                    t("publicPresence.home.launchTimeline.step.waves.qualification"),
                    t("publicPresence.home.launchTimeline.step.waves.gates"),
                  ]}
                />
              ) : null}
            </Stack>
          </Surface>
        ))}
      </Grid>
      <Inline>
        <LinkButton
          href="/#waitlist-form"
          tone="primary"
          size="sm"
          leadingIcon="rocket"
          onClick={() => trackCtaClick("launch_timeline", "waitlist_form", landingExperimentVariant)}
        >
          {t("publicPresence.home.launchTimeline.action")}
        </LinkButton>
      </Inline>
    </PageSection>
  );
}

function ProductSignalPreview({ checkoutFeePreview }: { checkoutFeePreview: CheckoutFeePreview }) {
  const landingExperimentVariant = useLandingExperimentVariant();

  // The concrete buyer-side checkout-fee presentation: the card processing
  // line states the real passthrough terms and the sample order resolves to
  // a concrete total, instead of a fee "quoted before payment".
  const checkoutFee = checkoutFeeTranslationValues(checkoutFeePreview);
  return (
    <PageSection
      id="product-preview"
      data-public-presence-section="product_preview"
      title={t("publicPresence.preview.section.title")}
      description={t("publicPresence.preview.section.description")}
    >
      <Grid columns={{ base: 1, lg: 2 }} gap={4}>
        <ListingCard
          title={t("publicPresence.preview.listing.title")}
          model="product"
          imageSrc={pikachuIllustrationRareUrl}
          imageAlt={t("publicPresence.preview.listing.imageAlt")}
          detailLinkLabel={t("publicPresence.preview.listing.viewDetails", {
            identity: t("publicPresence.preview.listing.title"),
          })}
          saveLabel={t("publicPresence.preview.listing.save", { identity: t("publicPresence.preview.listing.title") })}
          savedLabel={t("publicPresence.preview.listing.saved", {
            identity: t("publicPresence.preview.listing.title"),
          })}
          watchingLabel={t("publicPresence.preview.listing.watching", {
            identity: t("publicPresence.preview.listing.title"),
          })}
          imageLoading="lazy"
          imageFetchPriority="low"
          imageDecoding="async"
          imageWidth={420}
          imageHeight={587}
          promotion={t("publicPresence.preview.listing.badge")}
          price={t("publicPresence.preview.listing.price.value")}
          priceDetail={t("publicPresence.preview.listing.price.detail")}
          priceExplanation={t("publicPresence.preview.listing.price.explanation")}
          sellerName={t("publicPresence.preview.listing.seller.value")}
          sellerTrustLabel={t("publicPresence.preview.listing.seller.trust")}
          sellerMeta={t("publicPresence.preview.listing.seller.meta")}
          fulfillment={t("publicPresence.preview.listing.fulfillment.value")}
          availability={t("publicPresence.preview.listing.availability.value")}
          condition={t("publicPresence.preview.listing.condition.value")}
          valueCue={t("publicPresence.preview.listing.description")}
          truncateValueCue={false}
          protection={t("publicPresence.preview.listing.protection.value")}
          returnPolicy={t("publicPresence.preview.listing.returnPolicy.value")}
          primaryAction={
            <LinkButton
              href="/#waitlist-form"
              size="sm"
              onClick={() => trackCtaClick("product_preview", "waitlist_form", landingExperimentVariant)}
            >
              {t("publicPresence.preview.listing.action")}
            </LinkButton>
          }
          secondaryAction={
            <LinkButton
              href="/order-protection"
              tone="secondary"
              size="sm"
              onClick={() => trackCtaClick("product_preview", "order_protection", landingExperimentVariant)}
            >
              {t("publicPresence.preview.listing.secondaryAction")}
            </LinkButton>
          }
        />
        <Stack gap={4}>
          <PriceBreakdown
            title={t("publicPresence.preview.total.title")}
            description={t("publicPresence.preview.total.description", checkoutFee)}
            lines={[
              { label: t("publicPresence.preview.total.item"), value: t("publicPresence.preview.total.item.value") },
              { label: t("publicPresence.preview.total.shipping"), value: <DiscountedShippingValue /> },
              {
                label: t("publicPresence.preview.total.tax"),
                value: t("publicPresence.preview.total.tax.value"),
              },
              {
                label: t("publicPresence.preview.total.cardProcessing", checkoutFee),
                value: t("publicPresence.preview.total.cardProcessing.value", checkoutFee),
              },
            ]}
            totalLabel={t("publicPresence.preview.total.due")}
            total={t("publicPresence.preview.total.due.value", checkoutFee)}
            reassurance={t("publicPresence.preview.total.reassurance", checkoutFee)}
          />
          <Text size="sm" tone="tertiary">
            {t("publicPresence.preview.total.protectionCaption")}{" "}
            <LinkText href="/order-protection">
              <CoarsePointerLinkLabel>{t("publicPresence.preview.total.protectionLink")}</CoarsePointerLinkLabel>
            </LinkText>
          </Text>
          <Surface tone="subtle">
            <Stack gap={4}>
              <Heading level={3}>{t("publicPresence.preview.trust.title")}</Heading>
              {[
                ["publicPresence.preview.trust.payment.title", "publicPresence.preview.trust.payment.description"],
                ["publicPresence.preview.trust.shipping.title", "publicPresence.preview.trust.shipping.description"],
                ["publicPresence.preview.trust.support.title", "publicPresence.preview.trust.support.description"],
              ].map(([title, description]) => (
                <Stack key={title} gap={1}>
                  <Text weight="semibold">{t(title)}</Text>
                  <Text size="sm" tone="secondary">
                    {/* Checkout-fee values interpolate here; keys without those tokens ignore the extra values. */}
                    {t(description, checkoutFee)}
                  </Text>
                </Stack>
              ))}
            </Stack>
          </Surface>
        </Stack>
      </Grid>
    </PageSection>
  );
}

function DiscountedShippingValue() {
  return (
    <DiscountValue
      original={t("publicPresence.preview.total.shipping.original")}
      current={t("publicPresence.preview.total.shipping.net")}
    />
  );
}

function FounderStorySection({ discordInviteUrl }: { discordInviteUrl?: string | null }) {
  return (
    <PageSection
      data-public-presence-section="founder_story"
      title={t("publicPresence.home.founderStory.title")}
      description={t("publicPresence.home.founderStory.description")}
    >
      <Surface tone="subtle" elevated>
        <Stack gap={3}>
          <BadgeRow>
            <Badge tone="trust">{t("publicPresence.home.founderStory.badge")}</Badge>
          </BadgeRow>
          <Inline gap={3} align="center">
            <ToneIcon name="user" tone="trust" size="lg" label={t("publicPresence.home.founderStory.name")} />
            <Stack gap={0}>
              <Heading level={3}>{t("publicPresence.home.founderStory.name")}</Heading>
              <Text size="sm" tone="secondary">
                {t("publicPresence.home.founderStory.role")}
              </Text>
            </Stack>
          </Inline>
          <Text tone="secondary">{t("publicPresence.home.founderStory.story")}</Text>
          <List
            items={[
              t("publicPresence.home.founderStory.point.collector"),
              t("publicPresence.home.founderStory.point.transparency"),
              t("publicPresence.home.founderStory.point.roadmap"),
            ]}
          />
          <Inline gap={2}>
            {discordInviteUrl ? <DiscordInviteLink href={discordInviteUrl} section="founder_story" /> : null}
          </Inline>
        </Stack>
      </Surface>
    </PageSection>
  );
}

function FinalCtaSection({
  actionData,
  discordInviteUrl,
  intent,
  onIntentChange,
  source,
  selectedGame = null,
  landingExperimentVariant,
}: {
  actionData: WaitlistActionData;
  discordInviteUrl?: string | null;
  intent: WaitlistIntent;
  onIntentChange: (intent: WaitlistIntent) => void;
  source: WaitlistPageSource;
  selectedGame?: string | null;
  landingExperimentVariant: LandingExperimentVariant;
}) {
  return (
    <PageSection data-public-presence-section="final_cta">
      <Grid columns={{ base: 1, lg: 2 }} gap={5}>
        <Stack gap={3}>
          <Stack gap={2}>
            <BadgeRow>
              <Badge tone="success">{t("publicPresence.home.finalCta.badge")}</Badge>
            </BadgeRow>
            <Heading level={2}>{t("publicPresence.home.finalCta.title")}</Heading>
            <Text tone="secondary">{t("publicPresence.home.finalCta.description")}</Text>
          </Stack>
          <List
            items={[
              t("publicPresence.home.finalCta.point.foundingBadge"),
              t("publicPresence.home.finalCta.point.sellers"),
              t("publicPresence.home.finalCta.point.buyers"),
              t("publicPresence.home.finalCta.point.terms"),
            ]}
          />
          <Inline gap={2}>
            {discordInviteUrl ? <DiscordInviteLink href={discordInviteUrl} variant={landingExperimentVariant} /> : null}
            <LinkButton
              href="/founders"
              tone="secondary"
              size="lg"
              onClick={() => trackCtaClick("final_cta", "founders_terms", landingExperimentVariant)}
            >
              {t("publicPresence.home.foundersOffer.action")}
            </LinkButton>
          </Inline>
        </Stack>
        <WaitlistSignupPanel
          actionData={actionData}
          intent={intent}
          onIntentChange={onIntentChange}
          source={source}
          panelId="waitlist-form-final"
          variant="full"
          selectedGame={selectedGame}
          landingExperimentVariant={landingExperimentVariant}
        />
      </Grid>
    </PageSection>
  );
}

function WaitlistSignupPanel({
  actionData,
  intent,
  onIntentChange,
  panelId = "waitlist",
  source,
  variant = "full",
  waitlistCounterDisplay = null,
  selectedGame = null,
  landingExperimentVariant,
}: {
  actionData: WaitlistActionData;
  intent: WaitlistIntent;
  onIntentChange: (intent: WaitlistIntent) => void;
  panelId?: string;
  source: WaitlistPageSource;
  variant?: "hero" | "full";
  /** Rounded, threshold-gated waitlist headcount. `null` hides the counter (see `WAITLIST_COUNTER_DISPLAY_BUCKET`). */
  waitlistCounterDisplay?: number | null;
  /** Normalized `?game=` slug from a game roster tile / per-game campaign link; prefills the games selection. */
  selectedGame?: string | null;
  landingExperimentVariant: LandingExperimentVariant;
}) {
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [games, setGames] = useState<string[]>(selectedGame ? [selectedGame] : []);
  const [hasStoreLink, setHasStoreLink] = useState(false);
  const formStarted = useRef(false);
  const isHero = variant === "hero";
  const section = isHero ? "hero" : "final_cta";
  const prefillGameLabel = selectedGameLabel(selectedGame);

  // A game tile clicked after first render (client-side navigation) must
  // still land in the games selection, so the prefill merges reactively
  // instead of relying on initial state alone.
  useEffect(() => {
    if (!selectedGame) {
      return;
    }
    setGames((current) => (current.includes(selectedGame) ? current : [...current, selectedGame]));
  }, [selectedGame]);
  // Cohort quality fields are only collected on the full form (not the
  // compact hero/sticky variant) and only for sell/both intent -- they are
  // never a condition of joining the waitlist.
  const showSellerInventoryFields = !isHero && intent.role !== "buy";

  function trackFormStart(field: string) {
    if (formStarted.current) {
      return;
    }

    formStarted.current = true;
    trackWaitlistEvent("waitlist_form_started", {
      section,
      field,
      role: intent.role,
      interest: intent.interest,
      variant: landingExperimentVariant,
    });
  }

  function trackRoleSelected(role: WaitlistMarketplaceIntent) {
    trackFormStart("role");
    const nextIntent = { ...intent, role };
    onIntentChange(nextIntent);
    trackWaitlistEvent("waitlist_role_selected", {
      section,
      role,
      interest: intent.interest,
      variant: landingExperimentVariantForIntent(heroIntentValue(nextIntent)),
    });
  }

  function trackInterestSelected(interest: WaitlistInterest) {
    trackFormStart("interests");
    onIntentChange({ ...intent, interest });
    trackWaitlistEvent("waitlist_interest_selected", {
      section,
      role: intent.role,
      interest,
      variant: landingExperimentVariant,
    });
  }

  function trackHeroIntentSelected(value: string) {
    const nextIntent = resolveHeroIntent(value);
    trackFormStart("role");
    onIntentChange(nextIntent);
    trackWaitlistEvent("waitlist_role_selected", {
      section,
      role: nextIntent.role,
      interest: nextIntent.interest,
      variant: landingExperimentVariantForIntent(heroIntentValue(nextIntent)),
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    trackWaitlistEvent("waitlist_form_submitted", {
      section,
      role: String(formData.get("role") ?? intent.role),
      interest: String(formData.get("interests") ?? intent.interest),
      page_path: source.pagePath,
      utm_source: source.utmSource,
      utm_medium: source.utmMedium,
      utm_campaign: source.utmCampaign,
      variant: landingExperimentVariant,
    });
  }

  const panel = (
    <Surface id={panelId} elevated glow padding={isHero ? 2 : 4}>
      <Stack gap={isHero ? 2 : 4}>
        {isHero ? (
          <Stack gap={1}>
            <Text weight="semibold">{t("publicPresence.waitlist.compactTitle")}</Text>
            <Text size="sm" tone="secondary">
              {t("publicPresence.waitlist.compactDescription")}
            </Text>
            {prefillGameLabel ? (
              // Per-game proof point: a roster tile / per-game campaign link
              // landed here, so the panel confirms which game is prefilled.
              <Inline gap={1} align="center">
                <Badge tone="info">{prefillGameLabel}</Badge>
                <Text size="sm" tone="secondary">
                  {t("publicPresence.waitlist.gamePrefill")}
                </Text>
              </Inline>
            ) : null}
            {waitlistCounterDisplay !== null ? (
              <Inline gap={1} align="center">
                <ToneIcon name="users" tone="primary" size="sm" />
                <Text size="sm" weight="semibold">
                  {t("publicPresence.waitlist.counter.label", { count: waitlistCounterDisplay })}
                </Text>
              </Inline>
            ) : null}
          </Stack>
        ) : (
          <Stack gap={2}>
            <BadgeRow>
              <Badge tone="success">{t("publicPresence.waitlist.badge")}</Badge>
            </BadgeRow>
            <Heading level={2}>{t("publicPresence.waitlist.formTitle")}</Heading>
            <Text tone="secondary">{t("publicPresence.waitlist.formDescription")}</Text>
            <Text size="sm" tone="secondary">
              {t("publicPresence.waitlist.promise")}
            </Text>
          </Stack>
        )}
        {actionData?.status === "error" ? (
          <Banner tone="danger" title={t("publicPresence.waitlist.error.title")} description={actionData.message} />
        ) : null}
        <Form spacing="none" method="post" action="?index" onSubmit={handleSubmit}>
          <Stack gap={isHero ? 2 : 4}>
            {isHero ? (
              <Stack gap={1}>
                <Text size="sm" weight="semibold">
                  {t("publicPresence.waitlist.heroIntent.label")}
                </Text>
                <SegmentedControl
                  aria-label={t("publicPresence.waitlist.heroIntent.label")}
                  items={heroIntentItems}
                  value={heroIntentValue(intent)}
                  onValueChange={trackHeroIntentSelected}
                />
              </Stack>
            ) : null}
            <TextInput
              label={t("publicPresence.waitlist.email")}
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder={t("publicPresence.waitlist.email.placeholder")}
              onFocus={() => trackFormStart("email")}
              controlSize="lg"
            />
            {isHero ? (
              <>
                <HiddenInput name="role" value={intent.role} />
                <HiddenInput name="interests" value={intent.interest} />
                {/* The hero form stays minimal (email + intent, #3954): a game
                    prefill travels as hidden values, never as a visible field. */}
                {games.map((game) => (
                  <HiddenInput key={game} name="games" value={game} />
                ))}
              </>
            ) : (
              <Grid columns={{ base: 1, md: 2 }} gap={3}>
                <NativeSelect
                  label={t("publicPresence.waitlist.role")}
                  name="role"
                  value={intent.role}
                  items={roleItems}
                  required
                  onFocus={() => trackFormStart("role")}
                  onChange={(event) => trackRoleSelected(event.currentTarget.value as WaitlistMarketplaceIntent)}
                  controlSize="lg"
                />
                <NativeSelect
                  label={t("publicPresence.waitlist.interests")}
                  name="interests"
                  value={intent.interest}
                  description={t("publicPresence.waitlist.interests.description")}
                  items={interestSelectItems}
                  required
                  onFocus={() => trackFormStart("interests")}
                  onChange={(event) => trackInterestSelected(event.currentTarget.value as WaitlistInterest)}
                  controlSize="lg"
                />
              </Grid>
            )}
            {showSellerInventoryFields ? (
              <Stack gap={3}>
                <Stack gap={1}>
                  <Text weight="semibold">{t("publicPresence.waitlist.sellerInventory.title")}</Text>
                  <Text size="sm" tone="secondary">
                    {t("publicPresence.waitlist.sellerInventory.description")}
                  </Text>
                </Stack>
                <CheckboxGroup
                  label={t("publicPresence.waitlist.games.label")}
                  description={t("publicPresence.waitlist.games.description")}
                  name="games"
                  items={gameItems}
                  values={games}
                  onValuesChange={(nextGames) => {
                    trackFormStart("games");
                    setGames(nextGames);
                  }}
                />
                <NativeSelect
                  label={t("publicPresence.waitlist.inventorySize.label")}
                  name="inventorySize"
                  placeholder={t("publicPresence.waitlist.inventorySize.placeholder")}
                  items={inventorySizeItems}
                  onFocus={() => trackFormStart("inventorySize")}
                  controlSize="lg"
                />
                <Checkbox
                  label={t("publicPresence.waitlist.hasStoreLink.label")}
                  name="hasStoreLink"
                  value="yes"
                  checked={hasStoreLink}
                  onCheckedChange={(checked) => {
                    trackFormStart("hasStoreLink");
                    setHasStoreLink(checked === true);
                  }}
                />
                {hasStoreLink ? (
                  <TextInput
                    label={t("publicPresence.waitlist.storeUrl.label")}
                    name="storeUrl"
                    type="url"
                    placeholder={t("publicPresence.waitlist.storeUrl.placeholder")}
                    onFocus={() => trackFormStart("storeUrl")}
                    controlSize="lg"
                  />
                ) : null}
              </Stack>
            ) : null}
            {isHero ? null : (
              <Checkbox
                label={t("publicPresence.waitlist.marketingConsent")}
                description={t("publicPresence.waitlist.marketingConsent.description")}
                name="marketingConsent"
                value="yes"
                checked={marketingConsent}
                onCheckedChange={(checked) => {
                  const consentChecked = checked === true;
                  trackFormStart("marketingConsent");
                  setMarketingConsent(consentChecked);
                  trackWaitlistEvent("waitlist_marketing_consent_checked", {
                    section,
                    checked: consentChecked,
                    role: intent.role,
                    interest: intent.interest,
                    variant: landingExperimentVariant,
                  });
                }}
              />
            )}
            <HoneypotInput name="website" />
            <HiddenInput name="pagePath" value={source.pagePath} />
            <HiddenInput name="referrer" value={source.referrer ?? ""} />
            <HiddenInput name="utmSource" value={source.utmSource ?? ""} />
            <HiddenInput name="utmMedium" value={source.utmMedium ?? ""} />
            <HiddenInput name="utmCampaign" value={source.utmCampaign ?? ""} />
            <HiddenInput name="utmContent" value={source.utmContent ?? ""} />
            <HiddenInput name="utmTerm" value={source.utmTerm ?? ""} />
            <HiddenInput name="referredBySignupId" value={source.referredBySignupId ?? ""} />
            <HiddenInput name="landingExperimentVariant" value={landingExperimentVariant} />
            <Button type="submit" size={isHero ? "md" : "lg"} block leadingIcon="rocket">
              {t("publicPresence.waitlist.submit")}
            </Button>
            <Text size="sm" tone="secondary">
              {isHero ? t("publicPresence.waitlist.impliedConsent") : t("publicPresence.waitlist.noCommitment")}
            </Text>
          </Stack>
        </Form>
      </Stack>
    </Surface>
  );

  return panel;
}

function FaqPreview({ checkoutFeePreview }: { checkoutFeePreview: CheckoutFeePreview }) {
  const landingExperimentVariant = useLandingExperimentVariant();

  const previewQuestions = [
    ["publicPresence.faq.launch.question", "publicPresence.faq.launch.answer"],
    ["publicPresence.faq.fees.question", "publicPresence.faq.fees.answer"],
  ];
  const answerValues = { ...launchTimeline, ...checkoutFeeTranslationValues(checkoutFeePreview) };

  return (
    <PageSection
      data-public-presence-section="faq"
      title={t("publicPresence.faq.title")}
      description={t("publicPresence.faq.description")}
    >
      <Inline>
        <LinkButton href="/faq" tone="secondary" onClick={() => trackCtaClick("faq", "faq", landingExperimentVariant)}>
          {t("publicPresence.faq.all")}
        </LinkButton>
      </Inline>
      <Grid columns={{ base: 1, md: 2 }} gap={4}>
        {previewQuestions.map(([question, answer]) => (
          <Surface key={question} tone="subtle">
            <Stack gap={2}>
              <Heading level={3}>{t(question)}</Heading>
              {/* Launch-timeline and checkout-fee values interpolate here;
                  keys without those tokens ignore the extra values. */}
              <Text tone="secondary">{t(answer, answerValues)}</Text>
            </Stack>
          </Surface>
        ))}
      </Grid>
    </PageSection>
  );
}

export type PublicInfoPageContent = Readonly<{
  eyebrow: string;
  title: string;
  description: string;
  sections: readonly Readonly<{
    title: string;
    body: readonly string[];
  }>[];
}>;

export function PublicInfoPage({ content }: { content: PublicInfoPageContent }) {
  return (
    <PublicPresencePageShell>
      <Page>
        <PageHeader eyebrow={content.eyebrow} title={content.title} description={content.description} />
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          {content.sections.map((section) => (
            <Surface key={section.title} elevated>
              <Stack gap={3}>
                <Heading level={2}>{section.title}</Heading>
                {section.body.map((paragraph) => (
                  <Text key={paragraph} tone="secondary">
                    {paragraph}
                  </Text>
                ))}
              </Stack>
            </Surface>
          ))}
        </Grid>
      </Page>
    </PublicPresencePageShell>
  );
}
