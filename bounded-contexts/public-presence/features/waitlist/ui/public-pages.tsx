import { t } from "@chase-sets/localization";
import { useState, type ReactNode } from "react";
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
import pikachuIllustrationRareUrl from "../../../support/shell-support/assets/pikachu-illustration-rare.png?url";
import waitlistCardPanelsUrl from "../../../support/shell-support/assets/chase-sets-waitlist-card-panels.webp?url";

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
    value: "low-seller-fees",
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


const policyLinks = [
  { href: "/terms", label: t("publicPresence.nav.terms") },
  { href: "/privacy", label: t("publicPresence.nav.privacy") },
  { href: "/refunds-and-returns", label: t("publicPresence.nav.refunds") },
  { href: "/buyer-protection", label: t("publicPresence.nav.buyerProtection") },
  { href: "/seller-fees", label: t("publicPresence.nav.sellerFees") },
];

function DiscordInviteLink({ href }: { href: string }) {
  return (
    <LinkButton
      href={href}
      tone="secondary"
      size="lg"
      leadingIcon="message"
      target="_blank"
      rel="noopener noreferrer"
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
                <Inline gap={2}>
                  <LinkText href="#product-preview" tone="subtle">
                    {t("publicPresence.nav.product")}
                  </LinkText>
                  <LinkText href="/faq" tone="subtle">
                    {t("publicPresence.nav.faq")}
                  </LinkText>
                  <LinkText href="/terms" tone="subtle">
                    {t("publicPresence.nav.policies")}
                  </LinkText>
                </Inline>
              </Inline>
              <LinkButton href="#waitlist-form" tone="primary" size="sm" leadingIcon="rocket">
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
  return (
    <PublicPresencePageShell>
      <Page>
        <MarketingImageHero
          imageSrc={waitlistCardPanelsUrl}
          imageAlt={t("publicPresence.home.heroImageAlt")}
          imagePosition="center"
          eyebrow={t("publicPresence.home.eyebrow")}
          title={t("publicPresence.home.title")}
          description={t("publicPresence.home.description")}
          conversionPanel={
            <WaitlistSignupPanel
              actionData={actionData}
              source={source}
              panelId="waitlist-form"
              compact
            />
          }
        />

        <HeroSignalStrip />

        <ProductSignalPreview />

        <BuyerSellerLandingSection />

        <LaunchPriorityPanel />

        <SignupExpectationSection />

        <FinalCtaSection
          actionData={actionData}
          discordInviteUrl={discordInviteUrl}
          source={source}
        />

        <FaqPreview />
      </Page>
    </PublicPresencePageShell>
  );
}

function SignupExpectationSection() {
  return (
    <PageSection
      title={t("publicPresence.waitlist.expectations.title")}
      description={t("publicPresence.waitlist.description")}
    >
      <Grid columns={{ base: 1, md: 2 }} gap={4}>
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
            <Heading level={3}>{t("publicPresence.waitlist.trust.title")}</Heading>
            <List
              items={[
                t("publicPresence.waitlist.trust.noTransactions"),
                t("publicPresence.waitlist.trust.policies"),
                t("publicPresence.waitlist.trust.support"),
                t("publicPresence.waitlist.trust.review"),
              ]}
            />
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
  return (
    <PageSection
      title={t("publicPresence.home.howItWorks.title")}
      description={t("publicPresence.home.howItWorks.description")}
    >
      <Grid columns={{ base: 1, md: 3 }} gap={4}>
        {[
          ["publicPresence.home.model.supply.title", "publicPresence.home.model.supply.description"],
          ["publicPresence.home.model.economics.title", "publicPresence.home.model.economics.description"],
          ["publicPresence.home.model.trust.title", "publicPresence.home.model.trust.description"],
        ].map(([title, description]) => (
          <Surface key={title} elevated>
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

function BuyerSellerLandingSection() {
  return (
    <PageSection
      title={t("publicPresence.home.audience.title")}
      description={t("publicPresence.home.audience.description")}
    >
      <Grid columns={{ base: 1, md: 2 }} gap={4}>
        <Surface tone="subtle">
          <Stack gap={3}>
            <BadgeRow>
              <Badge tone="success">{t("publicPresence.home.audience.buyer.badge")}</Badge>
            </BadgeRow>
            <Heading level={3}>{t("publicPresence.home.buying.title")}</Heading>
            <Text tone="secondary">{t("publicPresence.home.audience.buyer.description")}</Text>
            <List
              items={[
                t("publicPresence.home.buying.point.pricing"),
                t("publicPresence.home.buying.point.cart"),
                t("publicPresence.home.buying.point.shipping"),
              ]}
            />
          </Stack>
        </Surface>
        <Surface tone="subtle">
          <Stack gap={3}>
            <BadgeRow>
              <Badge tone="warning">{t("publicPresence.home.audience.seller.badge")}</Badge>
            </BadgeRow>
            <Heading level={3}>{t("publicPresence.home.selling.title")}</Heading>
            <Text tone="secondary">{t("publicPresence.home.audience.seller.description")}</Text>
            <List
              items={[
                t("publicPresence.home.selling.point.fees"),
                t("publicPresence.home.selling.point.bulk"),
                t("publicPresence.home.selling.point.repricing"),
              ]}
            />
          </Stack>
        </Surface>
      </Grid>
    </PageSection>
  );
}

function ProductSignalPreview() {
  return (
    <PageSection
      id="product-preview"
      title={t("publicPresence.preview.section.title")}
      description={t("publicPresence.preview.section.description")}
    >
      <Grid columns={{ base: 1, lg: 2 }} gap={4}>
        <ListingCard
          title={t("publicPresence.preview.listing.title")}
          model="product"
          imageSrc={pikachuIllustrationRareUrl}
          imageAlt={t("publicPresence.preview.listing.imageAlt")}
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
            <LinkButton href="#waitlist-form" size="sm">
              {t("publicPresence.preview.listing.action")}
            </LinkButton>
          )}
          secondaryAction={(
            <LinkButton href="/buyer-protection" tone="secondary" size="sm">
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
              { label: t("publicPresence.preview.total.shipping"), value: t("publicPresence.preview.total.shipping.value") },
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

function FinalCtaSection({
  actionData,
  discordInviteUrl,
  source,
}: {
  actionData: WaitlistActionData;
  discordInviteUrl?: string | null;
  source: Parameters<typeof PublicPresenceHomePage>[0]["source"];
}) {
  return (
    <PageSection>
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
              t("publicPresence.home.finalCta.point.buyers"),
              t("publicPresence.home.finalCta.point.sellers"),
              t("publicPresence.home.finalCta.point.terms"),
            ]}
          />
          <Inline gap={2}>
            {discordInviteUrl ? <DiscordInviteLink href={discordInviteUrl} /> : null}
          </Inline>
        </Stack>
        <WaitlistSignupPanel
          actionData={actionData}
          source={source}
          panelId="waitlist-form-final"
        />
      </Grid>
    </PageSection>
  );
}

function WaitlistSignupPanel({
  actionData,
  panelId = "waitlist",
  source,
  compact = false,
}: {
  actionData: WaitlistActionData;
  panelId?: string;
  source: Parameters<typeof PublicPresenceHomePage>[0]["source"];
  compact?: boolean;
}) {
  const [emailConsent, setEmailConsent] = useState(false);

  const panel = (
    <Surface id={panelId} elevated glow padding={compact ? 3 : 4}>
      <Stack gap={compact ? 3 : 4}>
        <Stack gap={2}>
          <BadgeRow>
            <Badge tone="success">{t("publicPresence.waitlist.badge")}</Badge>
          </BadgeRow>
          <Heading level={compact ? 3 : 2}>
            {t(compact ? "publicPresence.waitlist.heroTitle" : "publicPresence.waitlist.formTitle")}
          </Heading>
          {!compact ? (
            <Text tone="secondary">{t("publicPresence.waitlist.formDescription")}</Text>
          ) : null}
          {!compact ? (
            <Text size="sm" tone="secondary">{t("publicPresence.waitlist.promise")}</Text>
          ) : null}
        </Stack>
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
        <form method="post" action="?index">
          <Stack gap={compact ? 3 : 4}>
            <TextInput
              label={t("publicPresence.waitlist.email")}
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder={t("publicPresence.waitlist.email.placeholder")}
            />
            <Grid columns={{ base: 1, md: 2 }} gap={3}>
              <NativeSelect
                label={t("publicPresence.waitlist.role")}
                name="role"
                defaultValue="both"
                items={roleItems}
                required
              />
              <NativeSelect
                label={t("publicPresence.waitlist.interests")}
                name="interests"
                defaultValue="set-completion"
                description={!compact ? t("publicPresence.waitlist.interests.description") : undefined}
                items={interestSelectItems}
                required
              />
            </Grid>
            <Checkbox
              label={t("publicPresence.waitlist.consent")}
              description={!compact ? t("publicPresence.waitlist.consent.description") : undefined}
              checked={emailConsent}
              onCheckedChange={(checked) => setEmailConsent(checked === true)}
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
      title={t("publicPresence.faq.title")}
      description={t("publicPresence.faq.description")}
    >
      <Inline>
        <LinkButton href="/faq" tone="secondary">{t("publicPresence.faq.all")}</LinkButton>
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
