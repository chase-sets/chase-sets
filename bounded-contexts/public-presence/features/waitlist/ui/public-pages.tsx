import { t } from "@chase-sets/localization";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Banner,
  Badge,
  BrandLink,
  Button,
  Checkbox,
  ChaseRoot,
  Cluster,
  Container,
  Grid,
  Heading,
  Inline,
  LinkButton,
  LinkText,
  ListingCard,
  List,
  MarketingImageHero,
  MarketingVisualCard,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  SkipLink,
  Stack,
  Surface,
  PriceBreakdown,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import prelaunchHeroUrl from "./assets/chase-sets-prelaunch-hero.webp?url";
import pikachuIllustrationRareUrl from "./assets/pikachu-illustration-rare-preview.webp?url";
import waitlistCardPanelsUrl from "./assets/chase-sets-waitlist-card-panels.webp?url";
import { trackWaitlistEvent } from "./analytics";

export type WaitlistActionData =
  | Readonly<{ status: "joined" }>
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
type WaitlistInterest =
  | "low-sales-fees"
  | "bulk-listing"
  | "set-completion"
  | "pricing-tools"
  | "efficient-shipping";

type WaitlistIntent = Readonly<{
  role: WaitlistMarketplaceIntent;
  interest: WaitlistInterest;
}>;

const defaultIntent: WaitlistIntent = {
  role: "both",
  interest: "low-sales-fees",
};

const sellerIntent: WaitlistIntent = {
  role: "sell",
  interest: "low-sales-fees",
};

const buyerIntent: WaitlistIntent = {
  role: "buy",
  interest: "set-completion",
};

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
    variant: "landing-audit-remediation",
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
            variant: "landing-audit-remediation",
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

export function PublicPresencePageShell({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <ChaseRoot colorMode="system">
      <SkipLink />
      <Container width="wide">
        <Stack gap={4}>
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
    </ChaseRoot>
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
      variant: "landing-audit-remediation",
    });
  }, [source]);

  useEffect(() => {
    if (actionData?.status === "joined") {
      trackWaitlistEvent("waitlist_signup_succeeded", {
        page_path: source.pagePath,
        role: intent.role,
        interest: intent.interest,
        variant: "landing-audit-remediation",
      });
    }

    if (actionData?.status === "error") {
      trackWaitlistEvent("waitlist_signup_failed", {
        page_path: source.pagePath,
        role: intent.role,
        interest: intent.interest,
        variant: "landing-audit-remediation",
      });
    }
  }, [actionData, intent, source.pagePath]);

  function selectIntent(nextIntent: WaitlistIntent, section: string) {
    setIntent(nextIntent);
    trackWaitlistEvent("cta_clicked", {
      section,
      cta_label: nextIntent.role === "sell"
        ? t("publicPresence.home.paths.sell.action")
        : t("publicPresence.home.paths.buy.action"),
      role: nextIntent.role,
      interest: nextIntent.interest,
      variant: "landing-audit-remediation",
    });

    document.getElementById("waitlist-form-final")?.scrollIntoView?.({
      behavior: "smooth",
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
            eyebrow={t("publicPresence.home.eyebrow")}
            title={t("publicPresence.home.title")}
            description={t("publicPresence.home.description")}
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

          <HeroSignalStrip />
        </Stack>

        <SellerEconomicsSection />

        <TrustBeforeTransactionsSection />

        <WhyJoinNow />

        <BuyerBundleProofSection />

        <ProductSignalPreview />

        <MarketplaceModelSection />

        <AudiencePathSection onIntentSelect={selectIntent} />

        <LaunchPriorityPanel />

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
              <Button
                tone="secondary"
                size="sm"
                onClick={() => onIntentSelect(sellerIntent, "audience_path_seller")}
              >
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
              <Button
                tone="secondary"
                size="sm"
                onClick={() => onIntentSelect(buyerIntent, "audience_path_buyer")}
              >
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
              items={[
                t("publicPresence.waitlist.trust.noTransactions"),
                t("publicPresence.waitlist.trust.review"),
              ]}
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

function HeroSignalStrip() {
  return (
    <Surface tone="subtle" padding={3}>
      <Grid columns={{ base: 1, md: 3 }} gap={3}>
        {[
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
        ].map((highlight) => (
          <Stack key={highlight.label} gap={1}>
            <Text size="sm" tone="secondary" weight="semibold">
              {highlight.label}
            </Text>
            <Text weight="semibold">{highlight.value}</Text>
          </Stack>
        ))}
      </Grid>
    </Surface>
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

function TrustBeforeTransactionsSection() {
  const trustItems = [
    ["publicPresence.home.trust.policies.title", "publicPresence.home.trust.policies.description"],
    ["publicPresence.home.trust.payment.title", "publicPresence.home.trust.payment.description"],
    ["publicPresence.home.trust.support.title", "publicPresence.home.trust.support.description"],
  ];

  return (
    <PageSection
      data-public-presence-section="trust"
      title={t("publicPresence.home.trust.title")}
      description={t("publicPresence.home.trust.description")}
    >
      <Grid columns={{ base: 1, md: 3 }} gap={4}>
        {trustItems.map(([title, description]) => (
          <Surface key={title} tone="subtle" elevated>
            <Stack gap={2}>
              <Heading level={3}>{t(title)}</Heading>
              <Text tone="secondary">{t(description)}</Text>
            </Stack>
          </Surface>
        ))}
      </Grid>
    </PageSection>
  );
}

function BuyerBundleProofSection() {
  return (
    <PageSection
      id="buyer-proof"
      data-public-presence-section="buyer_proof"
      title={t("publicPresence.home.buyerProof.title")}
      description={t("publicPresence.home.buyerProof.description")}
    >
      <Grid columns={{ base: 1, lg: 2 }} gap={4}>
        <PriceBreakdown
          title={t("publicPresence.home.buyerProof.math.title")}
          description={t("publicPresence.home.buyerProof.math.description")}
          lines={[
            {
              label: t("publicPresence.home.buyerProof.math.items"),
              value: t("publicPresence.home.buyerProof.math.items.value"),
            },
            {
              label: t("publicPresence.home.buyerProof.math.shipping"),
              value: <BuyerProofShippingValue />,
            },
            {
              label: t("publicPresence.home.buyerProof.math.shippingCredit"),
              value: t("publicPresence.home.buyerProof.math.shippingCredit.value"),
            },
            {
              label: t("publicPresence.home.buyerProof.math.orderProcessing"),
              value: t("publicPresence.home.buyerProof.math.orderProcessing.value"),
            },
            {
              label: t("publicPresence.home.buyerProof.math.protection"),
              value: t("publicPresence.home.buyerProof.math.protection.value"),
            },
          ]}
          totalLabel={t("publicPresence.home.buyerProof.math.total")}
          total={t("publicPresence.home.buyerProof.math.total.value")}
          reassurance={t("publicPresence.home.buyerProof.math.reassurance")}
        />
        <Surface tone="subtle" elevated>
          <Stack gap={3}>
            <BadgeRow>
              <Badge tone="success">{t("publicPresence.home.buyerProof.badge")}</Badge>
            </BadgeRow>
            <Heading level={3}>{t("publicPresence.home.buyerProof.workflow.title")}</Heading>
            <Text tone="secondary">{t("publicPresence.home.buyerProof.workflow.description")}</Text>
            <List
              items={[
                t("publicPresence.home.buyerProof.workflow.point.compare"),
                t("publicPresence.home.buyerProof.workflow.point.bundle"),
                t("publicPresence.home.buyerProof.workflow.point.review"),
              ]}
            />
          </Stack>
        </Surface>
      </Grid>
    </PageSection>
  );
}

function BuyerProofShippingValue() {
  return (
    <span className="inline-flex flex-wrap justify-end gap-x-1">
      <s className="text-[var(--destructive)] decoration-[var(--destructive)]">
        {t("publicPresence.home.buyerProof.math.shipping.original")}
      </s>
      <span className="text-[var(--trust)]">
        {t("publicPresence.home.buyerProof.math.shipping.net")}
      </span>
    </span>
  );
}

function WhyJoinNow() {
  const cards = [
    {
      titleKey: "publicPresence.home.whyJoin.lowValue.title",
      descriptionKey: "publicPresence.home.whyJoin.lowValue.description",
      badgeKey: "publicPresence.home.whyJoin.badge.inventory",
      badgeTone: "info" as const,
    },
    {
      titleKey: "publicPresence.home.whyJoin.sellers.title",
      descriptionKey: "publicPresence.home.whyJoin.sellers.description",
      badgeKey: "publicPresence.home.whyJoin.badge.seller",
      badgeTone: "warning" as const,
    },
    {
      titleKey: "publicPresence.home.whyJoin.access.title",
      descriptionKey: "publicPresence.home.whyJoin.access.description",
      badgeKey: "publicPresence.home.whyJoin.badge.buyer",
      badgeTone: "success" as const,
    },
  ];

  return (
    <PageSection
      data-public-presence-section="why_join"
      title={t("publicPresence.home.whyJoin.title")}
      description={t("publicPresence.home.whyJoin.description")}
    >
      <Grid columns={{ base: 1, md: 3 }} gap={4}>
        {cards.map((card) => (
          <Surface
            key={card.titleKey}
            tone="subtle"
            elevated
          >
            <Stack gap={3}>
              <BadgeRow>
                <Badge tone={card.badgeTone}>{t(card.badgeKey)}</Badge>
              </BadgeRow>
              <Heading level={3}>{t(card.titleKey)}</Heading>
              <Text tone="secondary">{t(card.descriptionKey)}</Text>
            </Stack>
          </Surface>
        ))}
      </Grid>
    </PageSection>
  );
}

function LaunchPriorityPanel() {
  return (
    <PageSection
      data-public-presence-section="launch_priority"
      title={t("publicPresence.home.launchPriority.title")}
      description={t("publicPresence.home.launchPriority.description")}
    >
      <Grid columns={{ base: 1, lg: 2 }} gap={5}>
        <Stack gap={3}>
          <BadgeRow>
            <Badge tone="info">{t("publicPresence.home.launchPriority.badge")}</Badge>
          </BadgeRow>
          <List
            items={[
              t("publicPresence.home.promise.lowValue"),
              t("publicPresence.home.promise.sellerTools"),
              t("publicPresence.home.promise.earlyAccess"),
            ]}
          />
        </Stack>
        <Surface tone="subtle">
          <Stack gap={3}>
            <Inline gap={2}>
              <Badge tone="success">{t("publicPresence.home.betaFee.badge")}</Badge>
              <Text size="sm" weight="semibold">{t("publicPresence.home.stat.status.value")}</Text>
            </Inline>
            <Heading level={3}>{t("publicPresence.home.betaFee.title")}</Heading>
            <Text tone="secondary">{t("publicPresence.home.betaFee.description")}</Text>
            <Grid columns={{ base: 1, md: 3 }} gap={3}>
              {[
                ["publicPresence.home.betaFee.rate", "publicPresence.home.betaFee.rateLabel"],
                ["publicPresence.home.betaFee.scope", "publicPresence.home.betaFee.scopeLabel"],
                ["publicPresence.home.betaFee.lock", "publicPresence.home.betaFee.lockLabel"],
              ].map(([value, label]) => (
                <Stack key={value} gap={1}>
                  <Text weight="bold">{t(value)}</Text>
                  <Text size="sm" tone="secondary">{t(label)}</Text>
                </Stack>
              ))}
            </Grid>
          </Stack>
        </Surface>
      </Grid>
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
          promotion={t("publicPresence.preview.listing.badge")}
          price={t("publicPresence.preview.listing.price.value")}
          priceDetail={t("publicPresence.preview.listing.price.detail")}
          priceExplanation={t("publicPresence.preview.listing.price.explanation")}
          rating={4.9}
          reviewCount="126"
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
          primaryAction={(
            <LinkButton
              href="#waitlist-form"
              size="sm"
              onClick={() => trackCtaClick("product_preview", "waitlist_form")}
            >
              {t("publicPresence.preview.listing.action")}
            </LinkButton>
          )}
          secondaryAction={(
            <LinkButton
              href="/order-protection"
              tone="secondary"
              size="sm"
              onClick={() => trackCtaClick("product_preview", "order_protection")}
            >
              {t("publicPresence.preview.listing.secondaryAction")}
            </LinkButton>
          )}
        />
        <Stack gap={4}>
          <PriceBreakdown
            title={t("publicPresence.preview.total.title")}
            description={t("publicPresence.preview.total.description")}
            lines={[
              { label: t("publicPresence.preview.total.item"), value: t("publicPresence.preview.total.item.value") },
              { label: t("publicPresence.preview.total.shipping"), value: <DiscountedShippingValue /> },
              { label: t("publicPresence.preview.total.shippingCredit"), value: t("publicPresence.preview.total.shippingCredit.value") },
              { label: t("publicPresence.preview.total.orderProcessing"), value: t("publicPresence.preview.total.orderProcessing.value") },
              { label: t("publicPresence.preview.total.protection"), value: t("publicPresence.preview.total.protection.value") },
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
                  <Text size="sm" tone="secondary">{t(description)}</Text>
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
    <span className="inline-flex flex-wrap justify-end gap-x-1">
      <s className="text-[var(--destructive)] decoration-[var(--destructive)]">
        {t("publicPresence.preview.total.shipping.original")}
      </s>
      <span className="text-[var(--trust)]">
        {t("publicPresence.preview.total.shipping.net")}
      </span>
    </span>
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
              t("publicPresence.home.finalCta.point.sellers"),
              t("publicPresence.home.finalCta.point.buyers"),
              t("publicPresence.home.finalCta.point.terms"),
            ]}
          />
          <Inline gap={2}>
            {discordInviteUrl ? <DiscordInviteLink href={discordInviteUrl} /> : null}
          </Inline>
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
  const [emailConsent, setEmailConsent] = useState(false);
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
      variant: "landing-audit-remediation",
    });
  }

  function trackRoleSelected(role: WaitlistMarketplaceIntent) {
    trackFormStart("role");
    onIntentChange({ ...intent, role });
    trackWaitlistEvent("waitlist_role_selected", {
      section,
      role,
      interest: intent.interest,
      variant: "landing-audit-remediation",
    });
  }

  function trackInterestSelected(interest: WaitlistInterest) {
    trackFormStart("interests");
    onIntentChange({ ...intent, interest });
    trackWaitlistEvent("waitlist_interest_selected", {
      section,
      role: intent.role,
      interest,
      variant: "landing-audit-remediation",
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    trackWaitlistEvent("waitlist_form_submitted", {
      section,
      role: String(formData.get("role") ?? intent.role),
      interest: String(formData.get("interests") ?? intent.interest),
      utm_source: source.utmSource,
      utm_medium: source.utmMedium,
      utm_campaign: source.utmCampaign,
      variant: "landing-audit-remediation",
    });
  }

  const panel = (
    <Surface id={panelId} elevated glow padding={isHero ? 2 : 4}>
      <Stack gap={isHero ? 2 : 4}>
        {isHero ? (
          <Stack gap={1}>
            <Text weight="semibold">{t("publicPresence.waitlist.compactTitle")}</Text>
            <Text size="sm" tone="secondary">{t("publicPresence.waitlist.compactDescription")}</Text>
          </Stack>
        ) : (
          <Stack gap={2}>
            <BadgeRow>
              <Badge tone="success">{t("publicPresence.waitlist.badge")}</Badge>
            </BadgeRow>
            <Heading level={2}>{t("publicPresence.waitlist.formTitle")}</Heading>
            <Text tone="secondary">{t("publicPresence.waitlist.formDescription")}</Text>
            <Text size="sm" tone="secondary">{t("publicPresence.waitlist.promise")}</Text>
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
          <Banner
            tone="danger"
            title={t("publicPresence.waitlist.error.title")}
            description={actionData.message}
          />
        ) : null}
        <form method="post" action="?index" onSubmit={handleSubmit}>
          <Stack gap={isHero ? 2 : 4}>
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
                <input type="hidden" name="role" value={intent.role} readOnly />
                <input type="hidden" name="interests" value={intent.interest} readOnly />
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
                  onChange={(event) => trackRoleSelected(
                    event.currentTarget.value as WaitlistMarketplaceIntent,
                  )}
                />
                <NativeSelect
                  label={t("publicPresence.waitlist.interests")}
                  name="interests"
                  value={intent.interest}
                  description={t("publicPresence.waitlist.interests.description")}
                  items={interestSelectItems}
                  required
                  onFocus={() => trackFormStart("interests")}
                  onChange={(event) => trackInterestSelected(
                    event.currentTarget.value as WaitlistInterest,
                  )}
                />
              </Grid>
            )}
            <Checkbox
              label={t("publicPresence.waitlist.consent")}
              description={t("publicPresence.waitlist.consent.description")}
              checked={emailConsent}
              onCheckedChange={(checked) => {
                const consentChecked = checked === true;
                trackFormStart("consent");
                setEmailConsent(consentChecked);
                trackWaitlistEvent("waitlist_consent_checked", {
                  section,
                  checked: consentChecked,
                  role: intent.role,
                  interest: intent.interest,
                  variant: "landing-audit-remediation",
                });
              }}
              required
            />
            {emailConsent ? (
              <input type="hidden" name="emailConsent" value="yes" readOnly />
            ) : null}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              hidden
            />
            <input type="hidden" name="pagePath" value={source.pagePath} readOnly />
            <input type="hidden" name="referrer" value={source.referrer ?? ""} readOnly />
            <input type="hidden" name="utmSource" value={source.utmSource ?? ""} readOnly />
            <input type="hidden" name="utmMedium" value={source.utmMedium ?? ""} readOnly />
            <input type="hidden" name="utmCampaign" value={source.utmCampaign ?? ""} readOnly />
            <input type="hidden" name="utmContent" value={source.utmContent ?? ""} readOnly />
            <input type="hidden" name="utmTerm" value={source.utmTerm ?? ""} readOnly />
            <Button type="submit" size="lg" block leadingIcon="rocket">
              {t("publicPresence.waitlist.submit")}
            </Button>
            <Text size="sm" tone="secondary">{t("publicPresence.waitlist.noCommitment")}</Text>
          </Stack>
        </form>
      </Stack>
    </Surface>
  );

  return panel;
}

function FaqPreview() {
  return (
    <PageSection
      data-public-presence-section="faq"
      title={t("publicPresence.faq.title")}
      description={t("publicPresence.faq.description")}
    >
      <Inline>
        <LinkButton
          href="/faq"
          tone="secondary"
          onClick={() => trackCtaClick("faq", "faq")}
        >
          {t("publicPresence.faq.all")}
        </LinkButton>
      </Inline>
      <Grid columns={{ base: 1, md: 2 }} gap={4}>
        {[
          ["publicPresence.faq.launch.question", "publicPresence.faq.launch.answer"],
          ["publicPresence.faq.fees.question", "publicPresence.faq.fees.answer"],
          ["publicPresence.faq.shipping.question", "publicPresence.faq.shipping.answer"],
          ["publicPresence.faq.safety.question", "publicPresence.faq.safety.answer"],
        ].map(([question, answer]) => (
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
        <PageHeader
          eyebrow={content.eyebrow}
          title={content.title}
          description={content.description}
        />
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          {content.sections.map((section) => (
            <Surface key={section.title} elevated>
              <Stack gap={3}>
                <Heading level={2}>{section.title}</Heading>
                {section.body.map((paragraph) => (
                  <Text key={paragraph} tone="secondary">{paragraph}</Text>
                ))}
              </Stack>
            </Surface>
          ))}
        </Grid>
      </Page>
    </PublicPresencePageShell>
  );
}
