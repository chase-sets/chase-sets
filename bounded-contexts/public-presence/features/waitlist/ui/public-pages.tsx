import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Form,
  Banner,
  Badge,
  BrandLink,
  Button,
  Checkbox,
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
  MarketingVisualCard,
  MobileStickyBar,
  MobileStickyInset,
  NativeSelect,
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
  type PromoBarMessage,
} from "@chase-sets/design-system";
import prelaunchHeroUrl from "./assets/chase-sets-prelaunch-hero.webp?url";
import pikachuIllustrationRareUrl from "./assets/pikachu-illustration-rare-preview.webp?url";
import waitlistCardPanelsUrl from "./assets/chase-sets-waitlist-card-panels.webp?url";
import { trackWaitlistEvent } from "./analytics";
import { publicPresenceT as t } from "./public-presence-translator";

export type WaitlistActionData =
  | Readonly<{ status: "joined"; id?: string; version?: number }>
  | Readonly<{ status: "error"; message: string }>
  | null;

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

type WaitlistMarketplaceIntent = "both" | "buy" | "sell";
type WaitlistInterest = "low-sales-fees" | "bulk-listing" | "set-completion" | "pricing-tools" | "efficient-shipping";

type WaitlistIntent = Readonly<{
  role: WaitlistMarketplaceIntent;
  interest: WaitlistInterest;
}>;

const defaultIntent: WaitlistIntent = {
  role: "both",
  interest: "low-sales-fees",
};

const landingExperimentVariant = "seller_first_v1";

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

const policyLinks = [
  { href: "/terms", label: t("publicPresence.nav.terms") },
  { href: "/privacy", label: t("publicPresence.nav.privacy") },
  { href: "/refunds-and-returns", label: t("publicPresence.nav.refunds") },
  { href: "/order-protection", label: t("publicPresence.nav.buyerProtection") },
  { href: "/sales-fees", label: t("publicPresence.nav.sellerFees") },
];

function trackCtaClick(placement: string, target: string) {
  trackWaitlistEvent("cta_clicked", {
    section: placement,
    target,
    variant: landingExperimentVariant,
  });
}

function useLandingSectionViewTracking() {
  useEffect(() => {
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      return undefined;
    }

    const viewedSections = new Set<string>();
    const sections = document.querySelectorAll<HTMLElement>("[data-public-presence-section]");
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const section = entry.target.getAttribute("data-public-presence-section");
          if (!section || viewedSections.has(section) || !entry.isIntersecting) {
            return;
          }
          viewedSections.add(section);
          trackWaitlistEvent("section_viewed", {
            section,
            variant: landingExperimentVariant,
          });
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.45 },
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);
}

function DiscordInviteLink({ href }: { href: string }) {
  return (
    <LinkButton
      href={href}
      tone="secondary"
      size="lg"
      leadingIcon="message"
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => trackCtaClick("final_cta", "discord")}
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

export function PublicPresencePageShell({ children }: { children: ReactNode }) {
  const promoBarMessages = usePromoBarMessages();

  return (
    <ChaseRoot colorMode="system">
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
                  href="#waitlist-form"
                  tone="primary"
                  size="sm"
                  leadingIcon="rocket"
                  onClick={() => trackCtaClick("nav", "waitlist_form")}
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
                      {link.label}
                    </LinkText>
                  ))}
                  <LinkText href="/contact">{t("publicPresence.nav.contact")}</LinkText>
                </Inline>
                <Text size="sm" tone="secondary">
                  {t("publicPresence.footer.description")}
                </Text>
              </Stack>
            </Surface>
          </Stack>
        </Container>
      </MobileStickyInset>
      <MobileStickyWaitlistCta />
    </ChaseRoot>
  );
}

function MobileStickyWaitlistCta() {
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
            onClick={() => trackCtaClick("mobile_sticky", "waitlist_form_final")}
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
}: {
  actionData: WaitlistActionData;
  discordInviteUrl?: string | null;
  source: Readonly<{
    pagePath: string;
    referrer: string | null;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    utmContent: string | null;
    utmTerm: string | null;
  }>;
}) {
  const [intent, setIntent] = useState<WaitlistIntent>(defaultIntent);

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
    if (actionData?.status === "joined") {
      trackWaitlistEvent("waitlist_signup_succeeded", {
        page_path: source.pagePath,
        role: intent.role,
        interest: intent.interest,
        variant: landingExperimentVariant,
      });
    }

    if (actionData?.status === "error") {
      trackWaitlistEvent("waitlist_signup_failed", {
        page_path: source.pagePath,
        role: intent.role,
        interest: intent.interest,
        variant: landingExperimentVariant,
      });
    }
  }, [actionData, intent, source.pagePath]);

  function selectIntent(nextIntent: WaitlistIntent, section: string) {
    setIntent(nextIntent);
    trackWaitlistEvent("cta_clicked", {
      section,
      cta_label:
        nextIntent.role === "sell"
          ? t("publicPresence.home.paths.sell.action")
          : t("publicPresence.home.paths.buy.action"),
      role: nextIntent.role,
      interest: nextIntent.interest,
      variant: landingExperimentVariant,
    });

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    document.getElementById("waitlist-form-final")?.scrollIntoView?.({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "start",
    });
  }

  useLandingSectionViewTracking();

  return (
    <PublicPresencePageShell>
      <Page>
        <Stack gap={2} data-public-presence-section="hero">
          <MarketingImageHero
            imageSrc={prelaunchHeroUrl}
            imageAlt={t("publicPresence.home.heroImageAlt")}
            imagePosition="center"
            imageLoading="eager"
            imageDecoding="async"
            imageFetchPriority="high"
            imageWidth={1600}
            imageHeight={1000}
            density="compact"
            eyebrow={t("publicPresence.home.eyebrow")}
            title={t("publicPresence.home.title")}
            description={t("publicPresence.home.description")}
            highlights={[
              {
                label: t("publicPresence.home.heroHighlight.lowValue.label"),
                value: t("publicPresence.home.heroHighlight.lowValue.value"),
              },
              {
                label: t("publicPresence.home.heroHighlight.workflow.label"),
                value: t("publicPresence.home.heroHighlight.workflow.value"),
              },
              {
                label: t("publicPresence.home.heroHighlight.launch.label"),
                value: t("publicPresence.home.heroHighlight.launch.value"),
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
              />
            }
          />
        </Stack>

        <SellerEconomicsSection />

        <FeeComparisonSection />

        <AudiencePathSection onIntentSelect={selectIntent} />

        <ProductSignalPreview />

        <MarketplaceModelSection />

        <SignupExpectationSection />

        <FinalCtaSection
          actionData={actionData}
          discordInviteUrl={discordInviteUrl}
          intent={intent}
          onIntentChange={setIntent}
          source={source}
        />

        <FaqPreview />
      </Page>
    </PublicPresencePageShell>
  );
}

function AudiencePathSection({
  onIntentSelect,
}: {
  onIntentSelect: (intent: WaitlistIntent, section: string) => void;
}) {
  return (
    <PageSection
      data-public-presence-section="audience_paths"
      title={t("publicPresence.home.paths.title")}
      description={t("publicPresence.home.paths.description")}
    >
      <Grid columns={{ base: 1, md: 2 }} gap={4}>
        <Surface tone="subtle" elevated>
          <Stack gap={3}>
            <BadgeRow>
              <Badge tone="warning">{t("publicPresence.home.paths.sell.badge")}</Badge>
            </BadgeRow>
            <Heading level={3}>{t("publicPresence.home.paths.sell.title")}</Heading>
            <Text tone="secondary">{t("publicPresence.home.paths.sell.description")}</Text>
            <List
              items={[
                t("publicPresence.home.paths.sell.point.feeLock"),
                t("publicPresence.home.paths.sell.point.bulk"),
                t("publicPresence.home.paths.sell.point.offers"),
              ]}
            />
            <Inline>
              <Button tone="secondary" size="sm" onClick={() => onIntentSelect(sellerIntent, "audience_path_seller")}>
                {t("publicPresence.home.paths.sell.action")}
              </Button>
            </Inline>
          </Stack>
        </Surface>
        <Surface tone="subtle" elevated>
          <Stack gap={3}>
            <BadgeRow>
              <Badge tone="success">{t("publicPresence.home.paths.buy.badge")}</Badge>
            </BadgeRow>
            <Heading level={3}>{t("publicPresence.home.paths.buy.title")}</Heading>
            <Text tone="secondary">{t("publicPresence.home.paths.buy.description")}</Text>
            <List
              items={[
                t("publicPresence.home.paths.buy.point.total"),
                t("publicPresence.home.paths.buy.point.shipping"),
                t("publicPresence.home.paths.buy.point.trust"),
              ]}
            />
            <Inline>
              <Button tone="secondary" size="sm" onClick={() => onIntentSelect(buyerIntent, "audience_path_buyer")}>
                {t("publicPresence.home.paths.buy.action")}
              </Button>
            </Inline>
          </Stack>
        </Surface>
      </Grid>
    </PageSection>
  );
}

function SignupExpectationSection() {
  return (
    <PageSection
      data-public-presence-section="signup_expectations"
      title={t("publicPresence.waitlist.expectations.title")}
      description={t("publicPresence.waitlist.description")}
    >
      <Grid columns={{ base: 1, md: 3 }} gap={4}>
        <Surface tone="subtle">
          <Stack gap={3}>
            <Heading level={3}>{t("publicPresence.waitlist.trust.title")}</Heading>
            <List
              items={[t("publicPresence.waitlist.trust.noTransactions"), t("publicPresence.waitlist.trust.review")]}
            />
          </Stack>
        </Surface>
        <Surface tone="subtle">
          <Stack gap={3}>
            <Heading level={3}>{t("publicPresence.waitlist.afterSignup.title")}</Heading>
            <List
              items={[
                t("publicPresence.waitlist.afterSignup.join"),
                t("publicPresence.waitlist.afterSignup.signal"),
                t("publicPresence.waitlist.afterSignup.updates"),
              ]}
            />
          </Stack>
        </Surface>
        <Surface tone="subtle">
          <Stack gap={3}>
            <Heading level={3}>{t("publicPresence.home.trust.support.title")}</Heading>
            <List
              items={[
                t("publicPresence.waitlist.trust.policies"),
                t("publicPresence.waitlist.trust.support"),
                t("publicPresence.home.trust.support.description"),
              ]}
            />
            <Inline>
              <LinkButton href="/terms" tone="secondary" size="sm">
                {t("publicPresence.home.trust.policies.title")}
              </LinkButton>
            </Inline>
          </Stack>
        </Surface>
      </Grid>
    </PageSection>
  );
}

function SellerEconomicsSection() {
  return (
    <PageSection
      id="seller-economics"
      data-public-presence-section="seller_economics"
      title={t("publicPresence.home.sellerEconomics.title")}
      description={t("publicPresence.home.sellerEconomics.description")}
    >
      <Grid columns={{ base: 1, lg: 2 }} gap={4}>
        <Surface tone="subtle" elevated>
          <Stack gap={3}>
            <BadgeRow>
              <Badge tone="success">{t("publicPresence.home.sellerEconomics.badge")}</Badge>
            </BadgeRow>
            <Heading level={3}>{t("publicPresence.home.sellerEconomics.lock.title")}</Heading>
            <Text tone="secondary">{t("publicPresence.home.sellerEconomics.lock.description")}</Text>
            <List
              items={[
                t("publicPresence.home.sellerEconomics.lock.point.beta"),
                t("publicPresence.home.sellerEconomics.lock.point.processing"),
                t("publicPresence.home.sellerEconomics.lock.point.change"),
              ]}
            />
          </Stack>
        </Surface>
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
      </Grid>
    </PageSection>
  );
}

// Fee-comparison sourcing: major-marketplace figures use each marketplace's
// own published seller-fee schedule, applied to a $10.00 item price before
// shipping or tax. Retrieved 2026-07-10.
// - Marketplace A = TCGplayer: 10.75% Marketplace-seller commission (Level
//   1-4, effective 2026-02-10) + 2.5% + $0.30 transaction fee.
//   https://help.tcgplayer.com/hc/en-us/articles/201357836-TCGplayer-Fees
//   https://seller.tcgplayer.com/blog/important-changes-to-tcgplayer-direct-minimum-pricing-and-marketplace-fees
// - Marketplace B = eBay: 13.25% trading-card final value fee (non-store
//   rate, on sale totals up to $7,500) + $0.30 per-order fee (orders of $10
//   or less).
//   https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=4822
// Named-vs-anonymized competitor labeling is a legal-safety call for product
// review; ship anonymized "Marketplace A/B" until product/legal picks a
// naming approach.
function FeeComparisonSection() {
  return (
    <PageSection
      data-public-presence-section="fee_comparison"
      title={t("publicPresence.home.sellerEconomics.comparison.title")}
      description={t("publicPresence.home.sellerEconomics.comparison.description")}
    >
      <Stack gap={3}>
        <Table
          caption={t("publicPresence.home.sellerEconomics.comparison.caption")}
          columns={[
            t("publicPresence.home.sellerEconomics.comparison.column.metric"),
            t("publicPresence.home.sellerEconomics.comparison.column.chaseSets"),
            t("publicPresence.home.sellerEconomics.comparison.column.marketplaceA"),
            t("publicPresence.home.sellerEconomics.comparison.column.marketplaceB"),
          ]}
          rows={[
            [
              t("publicPresence.home.sellerEconomics.comparison.row.marketplaceFee.label"),
              t("publicPresence.home.sellerEconomics.comparison.row.marketplaceFee.chaseSets"),
              t("publicPresence.home.sellerEconomics.comparison.row.marketplaceFee.marketplaceA"),
              t("publicPresence.home.sellerEconomics.comparison.row.marketplaceFee.marketplaceB"),
            ],
            [
              t("publicPresence.home.sellerEconomics.comparison.row.perOrderFee.label"),
              t("publicPresence.home.sellerEconomics.comparison.row.perOrderFee.chaseSets"),
              t("publicPresence.home.sellerEconomics.comparison.row.perOrderFee.marketplaceA"),
              t("publicPresence.home.sellerEconomics.comparison.row.perOrderFee.marketplaceB"),
            ],
            [
              t("publicPresence.home.sellerEconomics.comparison.row.youKeep.label"),
              <Badge tone="success" variant="solid">
                {t("publicPresence.home.sellerEconomics.comparison.row.youKeep.chaseSets")}
              </Badge>,
              t("publicPresence.home.sellerEconomics.comparison.row.youKeep.marketplaceA"),
              t("publicPresence.home.sellerEconomics.comparison.row.youKeep.marketplaceB"),
            ],
          ]}
        />
        <Text size="sm" tone="tertiary">
          {t("publicPresence.home.sellerEconomics.comparison.sourceNote")}
        </Text>
      </Stack>
    </PageSection>
  );
}

function MarketplaceModelSection() {
  const modelItems = [
    ["publicPresence.home.model.supply.title", "publicPresence.home.model.supply.description"],
    ["publicPresence.home.model.economics.title", "publicPresence.home.model.economics.description"],
    ["publicPresence.home.model.trust.title", "publicPresence.home.model.trust.description"],
  ];

  return (
    <PageSection
      data-public-presence-section="marketplace_model"
      title={t("publicPresence.home.howItWorks.title")}
      description={t("publicPresence.home.howItWorks.description")}
    >
      <Grid columns={{ base: 1, lg: 2 }} gap={4}>
        <MarketingVisualCard
          imageSrc={waitlistCardPanelsUrl}
          imageAlt={t("publicPresence.home.workflowImageAlt")}
          imagePosition="center"
          imageLoading="lazy"
          imageFetchPriority="low"
          imageDecoding="async"
          imageWidth={1200}
          imageHeight={900}
          badge={t("publicPresence.home.howItWorks.badge")}
          badgeTone="info"
          title={t("publicPresence.home.workflowImage.title")}
          description={t("publicPresence.home.workflowImage.description")}
        />
        <Grid columns={{ base: 1, md: 3, lg: 1 }} gap={3}>
          {modelItems.map(([title, description]) => (
            <Surface key={title} elevated>
              <Stack gap={2}>
                <Heading level={3}>{t(title)}</Heading>
                <Text tone="secondary">{t(description)}</Text>
              </Stack>
            </Surface>
          ))}
        </Grid>
      </Grid>
    </PageSection>
  );
}

function ProductSignalPreview() {
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
              href="#waitlist-form"
              size="sm"
              onClick={() => trackCtaClick("product_preview", "waitlist_form")}
            >
              {t("publicPresence.preview.listing.action")}
            </LinkButton>
          }
          secondaryAction={
            <LinkButton
              href="/order-protection"
              tone="secondary"
              size="sm"
              onClick={() => trackCtaClick("product_preview", "order_protection")}
            >
              {t("publicPresence.preview.listing.secondaryAction")}
            </LinkButton>
          }
        />
        <Stack gap={4}>
          <PriceBreakdown
            title={t("publicPresence.preview.total.title")}
            description={t("publicPresence.preview.total.description")}
            lines={[
              { label: t("publicPresence.preview.total.item"), value: t("publicPresence.preview.total.item.value") },
              { label: t("publicPresence.preview.total.shipping"), value: <DiscountedShippingValue /> },
              {
                label: t("publicPresence.preview.total.shippingCredit"),
                value: t("publicPresence.preview.total.shippingCredit.value"),
              },
              {
                label: t("publicPresence.preview.total.orderProcessing"),
                value: t("publicPresence.preview.total.orderProcessing.value"),
              },
              {
                label: t("publicPresence.preview.total.protection"),
                value: t("publicPresence.preview.total.protection.value"),
              },
            ]}
            totalLabel={t("publicPresence.preview.total.due")}
            total={t("publicPresence.preview.total.due.value")}
            reassurance={t("publicPresence.preview.total.reassurance")}
          />
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
                    {t(description)}
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

function FinalCtaSection({
  actionData,
  discordInviteUrl,
  intent,
  onIntentChange,
  source,
}: {
  actionData: WaitlistActionData;
  discordInviteUrl?: string | null;
  intent: WaitlistIntent;
  onIntentChange: (intent: WaitlistIntent) => void;
  source: Parameters<typeof PublicPresenceHomePage>[0]["source"];
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
          <Inline gap={2}>{discordInviteUrl ? <DiscordInviteLink href={discordInviteUrl} /> : null}</Inline>
        </Stack>
        <WaitlistSignupPanel
          actionData={actionData}
          intent={intent}
          onIntentChange={onIntentChange}
          source={source}
          panelId="waitlist-form-final"
          variant="full"
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
}: {
  actionData: WaitlistActionData;
  intent: WaitlistIntent;
  onIntentChange: (intent: WaitlistIntent) => void;
  panelId?: string;
  source: Parameters<typeof PublicPresenceHomePage>[0]["source"];
  variant?: "hero" | "full";
}) {
  const [marketingConsent, setMarketingConsent] = useState(false);
  const formStarted = useRef(false);
  const isHero = variant === "hero";
  const section = isHero ? "hero" : "final_cta";

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
    onIntentChange({ ...intent, role });
    trackWaitlistEvent("waitlist_role_selected", {
      section,
      role,
      interest: intent.interest,
      variant: landingExperimentVariant,
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
      variant: landingExperimentVariant,
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
        {actionData?.status === "joined" ? (
          <Banner
            tone="success"
            title={t("publicPresence.waitlist.success.title")}
            description={t("publicPresence.waitlist.success.description")}
          />
        ) : null}
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
            />
            {isHero ? (
              <>
                <HiddenInput name="role" value={intent.role} />
                <HiddenInput name="interests" value={intent.interest} />
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
                />
              </Grid>
            )}
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

function FaqPreview() {
  const previewQuestions = [
    ["publicPresence.faq.launch.question", "publicPresence.faq.launch.answer"],
    ["publicPresence.faq.fees.question", "publicPresence.faq.fees.answer"],
  ];

  return (
    <PageSection
      data-public-presence-section="faq"
      title={t("publicPresence.faq.title")}
      description={t("publicPresence.faq.description")}
    >
      <Inline>
        <LinkButton href="/faq" tone="secondary" onClick={() => trackCtaClick("faq", "faq")}>
          {t("publicPresence.faq.all")}
        </LinkButton>
      </Inline>
      <Grid columns={{ base: 1, md: 2 }} gap={4}>
        {previewQuestions.map(([question, answer]) => (
          <Surface key={question} tone="subtle">
            <Stack gap={2}>
              <Heading level={3}>{t(question)}</Heading>
              <Text tone="secondary">{t(answer)}</Text>
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
