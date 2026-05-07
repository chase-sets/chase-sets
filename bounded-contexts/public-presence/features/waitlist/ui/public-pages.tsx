import { t } from "@chase-sets/localization";
import { useState, type ReactNode } from "react";
import {
  Banner,
  Badge,
  BrandLink,
  Button,
  Checkbox,
  ChaseRoot,
  Container,
  Grid,
  Heading,
  Inline,
  LinkButton,
  LinkText,
  List,
  MarketingImageHero,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Stat,
  StatGrid,
  Surface,
  Text,
  TextInput,
  VisuallyHidden,
} from "@chase-sets/design-system";
import heroImageUrl from "../../../support/shell-support/assets/chase-sets-prelaunch-hero.webp?url";

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

export function PublicPresencePageShell({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <ChaseRoot colorMode="system">
      <Container width="wide">
        <Stack gap={6}>
          <Surface element="nav" tone="subtle" padding={3}>
            <Inline gap={3} align="center">
              <BrandLink label={t("publicPresence.brand")} />
              <LinkButton href="/" tone="secondary" size="sm">
                {t("publicPresence.nav.product")}
              </LinkButton>
              <LinkButton href="/faq" tone="secondary" size="sm">
                {t("publicPresence.nav.faq")}
              </LinkButton>
              <LinkButton href="/terms" tone="secondary" size="sm">
                {t("publicPresence.nav.policies")}
              </LinkButton>
            </Inline>
          </Surface>
          {children}
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
          imageSrc={heroImageUrl}
          imageAlt={t("publicPresence.home.heroImageAlt")}
          eyebrow={t("publicPresence.home.eyebrow")}
          title={t("publicPresence.home.title")}
          description={t("publicPresence.home.description")}
          actions={
            <Inline gap={2}>
              <LinkButton href="#waitlist" size="lg" leadingIcon="rocket">
                {t("publicPresence.home.primaryCta")}
              </LinkButton>
              {discordInviteUrl ? (
                <LinkButton href={discordInviteUrl} tone="secondary" size="lg" leadingIcon="message">
                  {t("publicPresence.home.discordCta")}
                </LinkButton>
              ) : null}
            </Inline>
          }
          conversionPanel={
            <WaitlistSignupPanel actionData={actionData} source={source} compact />
          }
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
        />

        <LaunchPriorityPanel />

        <WhyJoinNow />

        <BuyerSellerLandingSection />

        <ProductSignalPreview />

        <PageSection
          title={t("publicPresence.home.howItWorks.title")}
          description={t("publicPresence.home.howItWorks.description")}
        >
          <Grid columns={{ base: 1, md: 3 }} gap={4}>
            {[
              ["publicPresence.home.step.resolve.title", "publicPresence.home.step.resolve.description"],
              ["publicPresence.home.step.trade.title", "publicPresence.home.step.trade.description"],
              ["publicPresence.home.step.settle.title", "publicPresence.home.step.settle.description"],
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

        <EconomicsSignalSection />

        <PageSection
          title={t("publicPresence.home.trust.title")}
          description={t("publicPresence.home.trust.description")}
        >
          <Grid columns={{ base: 1, md: 3 }} gap={4}>
            {[
              ["publicPresence.home.trust.payment.title", "publicPresence.home.trust.payment.description"],
              ["publicPresence.home.trust.policies.title", "publicPresence.home.trust.policies.description"],
              ["publicPresence.home.trust.support.title", "publicPresence.home.trust.support.description"],
            ].map(([title, description]) => (
              <Surface key={title} tone="subtle">
                <Stack gap={2}>
                  <Heading level={3}>{t(title)}</Heading>
                  <Text tone="secondary">{t(description)}</Text>
                </Stack>
              </Surface>
            ))}
          </Grid>
        </PageSection>

        <FinalCtaSection discordInviteUrl={discordInviteUrl} />

        <FaqPreview />
      </Page>
    </PublicPresencePageShell>
  );
}

function WhyJoinNow() {
  return (
    <PageSection
      title={t("publicPresence.home.whyJoin.title")}
      description={t("publicPresence.home.whyJoin.description")}
    >
      <Grid columns={{ base: 1, md: 3 }} gap={4}>
        {[
          ["publicPresence.home.whyJoin.lowValue.title", "publicPresence.home.whyJoin.lowValue.description"],
          ["publicPresence.home.whyJoin.sellers.title", "publicPresence.home.whyJoin.sellers.description"],
          ["publicPresence.home.whyJoin.access.title", "publicPresence.home.whyJoin.access.description"],
        ].map(([title, description]) => (
          <Surface key={title} elevated glow>
            <Stack gap={2}>
              <Badge tone="info">{t("publicPresence.home.whyJoin.badge")}</Badge>
              <Heading level={3}>{t(title)}</Heading>
              <Text tone="secondary">{t(description)}</Text>
            </Stack>
          </Surface>
        ))}
      </Grid>
    </PageSection>
  );
}

function LaunchPriorityPanel() {
  return (
    <Surface elevated>
      <Stack gap={4}>
        <Stack gap={2}>
          <Badge tone="info">{t("publicPresence.home.launchPriority.badge")}</Badge>
          <Heading level={2}>{t("publicPresence.home.launchPriority.title")}</Heading>
          <Text tone="secondary">{t("publicPresence.home.launchPriority.description")}</Text>
        </Stack>
        <StatGrid columns={{ base: 1, md: 3 }}>
          <Stat label={t("publicPresence.home.stat.marketplace")} value={t("publicPresence.home.stat.marketplace.value")} />
          <Stat label={t("publicPresence.home.stat.cards")} value={t("publicPresence.home.stat.cards.value")} />
          <Stat label={t("publicPresence.home.stat.status")} value={t("publicPresence.home.stat.status.value")} />
        </StatGrid>
        <List
          items={[
            t("publicPresence.home.promise.lowValue"),
            t("publicPresence.home.promise.sellerTools"),
            t("publicPresence.home.promise.earlyAccess"),
          ]}
        />
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <WaitlistAfterSignupCues />
          <WaitlistTrustStrip />
        </Grid>
      </Stack>
    </Surface>
  );
}

function EconomicsSignalSection() {
  return (
    <PageSection
      title={t("publicPresence.home.economics.title")}
      description={t("publicPresence.home.economics.description")}
    >
      <Grid columns={{ base: 1, md: 3 }} gap={4}>
        {[
          ["publicPresence.home.economics.lowValue.title", "publicPresence.home.economics.lowValue.description"],
          ["publicPresence.home.economics.fees.title", "publicPresence.home.economics.fees.description"],
          ["publicPresence.home.economics.shipping.title", "publicPresence.home.economics.shipping.description"],
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
        <Surface elevated glow>
          <Stack gap={3}>
            <Badge tone="success">{t("publicPresence.home.audience.buyer.badge")}</Badge>
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
        <Surface elevated glow>
          <Stack gap={3}>
            <Badge tone="warning">{t("publicPresence.home.audience.seller.badge")}</Badge>
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
      title={t("publicPresence.preview.section.title")}
      description={t("publicPresence.preview.section.description")}
    >
    <Surface elevated>
      <Stack gap={4}>
        <Inline gap={2}>
          <Text weight="semibold">{t("publicPresence.preview.title")}</Text>
          <Text size="sm" tone="secondary">{t("publicPresence.preview.status")}</Text>
        </Inline>
        <Surface tone="subtle">
          <Grid columns={{ base: 1, md: 2 }} gap={3}>
            <Stack gap={1}>
              <Text weight="semibold">{t("publicPresence.preview.card.name")}</Text>
              <Text size="sm" tone="secondary">{t("publicPresence.preview.card.details")}</Text>
            </Stack>
            <Stack gap={1}>
              <Text weight="semibold">{t("publicPresence.preview.price")}</Text>
              <Text size="sm" tone="secondary">{t("publicPresence.preview.price.detail")}</Text>
            </Stack>
          </Grid>
        </Surface>
        <Grid columns={{ base: 1, md: 3 }} gap={3}>
          <Surface tone="subtle">
            <Text weight="semibold">{t("publicPresence.preview.signal.fees")}</Text>
            <Text size="sm" tone="secondary">{t("publicPresence.preview.signal.fees.detail")}</Text>
          </Surface>
          <Surface tone="subtle">
            <Text weight="semibold">{t("publicPresence.preview.signal.shipping")}</Text>
            <Text size="sm" tone="secondary">{t("publicPresence.preview.signal.shipping.detail")}</Text>
          </Surface>
          <Surface tone="subtle">
            <Text weight="semibold">{t("publicPresence.preview.signal.trust")}</Text>
            <Text size="sm" tone="secondary">{t("publicPresence.preview.signal.trust.detail")}</Text>
          </Surface>
        </Grid>
      </Stack>
    </Surface>
    </PageSection>
  );
}

function FinalCtaSection({
  discordInviteUrl,
}: {
  discordInviteUrl?: string | null;
}) {
  return (
    <Surface tone="accent" elevated glow padding={6}>
      <Stack gap={4}>
        <Stack gap={2}>
          <Badge tone="neutral">{t("publicPresence.home.finalCta.badge")}</Badge>
          <Heading level={2}>{t("publicPresence.home.finalCta.title")}</Heading>
          <Text tone="inverse">{t("publicPresence.home.finalCta.description")}</Text>
        </Stack>
        <Inline gap={2}>
          <LinkButton href="#waitlist" size="lg" leadingIcon="rocket">
            {t("publicPresence.home.primaryCta")}
          </LinkButton>
          {discordInviteUrl ? (
            <LinkButton href={discordInviteUrl} tone="secondary" size="lg" leadingIcon="message">
              {t("publicPresence.home.discordCta")}
            </LinkButton>
          ) : null}
        </Inline>
      </Stack>
    </Surface>
  );
}

function WaitlistSignupPanel({
  actionData,
  source,
  compact = false,
}: {
  actionData: WaitlistActionData;
  source: Parameters<typeof PublicPresenceHomePage>[0]["source"];
  compact?: boolean;
}) {
  const [emailConsent, setEmailConsent] = useState(false);

  return (
      <Surface id="waitlist" elevated glow>
        <Stack gap={4}>
          <Stack gap={2}>
            <Badge tone="success">{t("publicPresence.waitlist.badge")}</Badge>
            <Heading level={compact ? 3 : 2}>
              {t(compact ? "publicPresence.waitlist.heroTitle" : "publicPresence.waitlist.title")}
            </Heading>
            <Text tone="secondary">
              {t(compact ? "publicPresence.waitlist.heroDescription" : "publicPresence.waitlist.description")}
            </Text>
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
          <form method="post">
            <Stack gap={4}>
              <TextInput
                label={t("publicPresence.waitlist.email")}
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder={t("publicPresence.waitlist.email.placeholder")}
              />
              {compact ? (
                <>
                  <input type="hidden" name="role" value="both" readOnly />
                  <NativeSelect
                    label={t("publicPresence.waitlist.interests")}
                    name="interests"
                    defaultValue="low-seller-fees"
                    items={interestSelectItems}
                    required
                  />
                </>
              ) : (
                <>
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
                    defaultValue="low-seller-fees"
                    description={t("publicPresence.waitlist.interests.description")}
                    items={interestSelectItems}
                    required
                  />
                </>
              )}
              <Checkbox
                label={t("publicPresence.waitlist.consent")}
                checked={emailConsent}
                onCheckedChange={(checked) => setEmailConsent(checked === true)}
                required
              />
              {emailConsent ? (
                <input type="hidden" name="emailConsent" value="yes" readOnly />
              ) : null}
              <VisuallyHidden>
                <label>
                  {t("publicPresence.waitlist.website")}
                  <input name="website" tabIndex={-1} autoComplete="off" />
                </label>
              </VisuallyHidden>
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
}

function WaitlistAfterSignupCues() {
  return (
    <Surface tone="subtle" padding={3}>
      <Stack gap={2}>
        <Text size="sm" weight="semibold">{t("publicPresence.waitlist.afterSignup.title")}</Text>
        <List
          items={[
            t("publicPresence.waitlist.afterSignup.join"),
            t("publicPresence.waitlist.afterSignup.signal"),
            t("publicPresence.waitlist.afterSignup.updates"),
          ]}
        />
      </Stack>
    </Surface>
  );
}

function WaitlistTrustStrip() {
  return (
    <Surface tone="subtle" padding={3}>
      <Stack gap={2}>
        <Text size="sm" weight="semibold">{t("publicPresence.waitlist.trust.title")}</Text>
        <Inline gap={2}>
          {[
            "publicPresence.waitlist.trust.policies",
            "publicPresence.waitlist.trust.review",
            "publicPresence.waitlist.trust.noTransactions",
            "publicPresence.waitlist.trust.support",
          ].map((key) => (
            <Badge key={key} tone="neutral">{t(key)}</Badge>
          ))}
        </Inline>
      </Stack>
    </Surface>
  );
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
