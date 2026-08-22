import {
  Grid,
  Heading,
  Inline,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  ProgressiveDisclosureGroup,
  Stack,
  Surface,
  Table,
  Text,
} from "@chase-sets/design-system";
import { formatBpsPercent, formatMoney } from "@chase-sets/localization";
import { trackWaitlistEvent } from "./analytics";
import {
  FeeCalculatorSection,
  ebayFeeFacts,
  tcgplayerFeeFacts,
  type FeeComparisonCompetitor,
  type PublicMarketplaceFeeSchedule,
} from "./fee-comparison-calculator";
import { launchTimeline } from "./launch-config";
import { PublicPresencePageShell } from "./public-pages";
import { publicPresenceT as t } from "./public-presence-translator";

/**
 * Evergreen comparison SEO pages: Chase Sets vs a named competitor,
 * side by side. Every fee number is either loaded live from the published
 * Chase Sets schedule (truth-gated: the live cell and calculator degrade to
 * a qualitative reference when the policy read fails) or derived from the
 * same dated competitor constants the fee calculator computes with — the
 * copy can never cite a number the calculator would not produce.
 */

const competitorNameKeys = {
  tcgplayer: "publicPresence.home.feeCalculator.column.tcgplayer",
  ebay: "publicPresence.home.feeCalculator.column.ebay",
} as const satisfies Record<FeeComparisonCompetitor, string>;

const competitorFeeFactValues = {
  tcgplayer: tcgplayerFeeFacts,
  ebay: ebayFeeFacts,
} as const satisfies Record<FeeComparisonCompetitor, Readonly<Record<string, string>>>;

const compareMetaKeys = {
  tcgplayer: {
    metaTitleKey: "publicPresence.routes.compareTcgplayer.meta.title",
    metaDescriptionKey: "publicPresence.routes.compareTcgplayer.meta.description",
  },
  ebay: {
    metaTitleKey: "publicPresence.routes.compareEbay.meta.title",
    metaDescriptionKey: "publicPresence.routes.compareEbay.meta.description",
  },
} as const satisfies Record<FeeComparisonCompetitor, Readonly<{ metaTitleKey: string; metaDescriptionKey: string }>>;

function competitorKey(competitor: FeeComparisonCompetitor, suffix: string) {
  return `publicPresence.compare.${competitor}.${suffix}`;
}

function competitorValues(competitor: FeeComparisonCompetitor) {
  return {
    ...competitorFeeFactValues[competitor],
    ...launchTimeline,
    competitor: t(competitorNameKeys[competitor]),
  };
}

export function compareCompetitorName(competitor: FeeComparisonCompetitor) {
  return t(competitorNameKeys[competitor]);
}

export function compareMeta(competitor: FeeComparisonCompetitor, publicOrigin = "https://chasesets.com") {
  const keys = compareMetaKeys[competitor];
  const pageUrl = comparePageUrl(competitor, publicOrigin);

  return [
    { title: t(keys.metaTitleKey) },
    { name: "description", content: t(keys.metaDescriptionKey) },
    { property: "og:site_name", content: t("publicPresence.brand") },
    { property: "og:title", content: t(keys.metaTitleKey) },
    { property: "og:description", content: t(keys.metaDescriptionKey) },
    { property: "og:type", content: "website" },
    { property: "og:url", content: pageUrl },
  ];
}

/** Stable bounded item identity for the disclosure group; positions match `buildCompareFaqEntries`. */
const compareFaqItemValues = ["competitor-fees", "chase-sets-fees", "keep-more", "launch"] as const;

/** The visible FAQ and the FAQPage structured data render from this same list. */
export function buildCompareFaqEntries(competitor: FeeComparisonCompetitor) {
  const values = competitorValues(competitor);

  return [
    {
      question: t(competitorKey(competitor, "faq.competitorFees.question")),
      answer: t(competitorKey(competitor, "faq.competitorFees.answer"), values),
    },
    {
      question: t("publicPresence.compare.faq.chaseSetsFees.question"),
      answer: t("publicPresence.compare.faq.chaseSetsFees.answer"),
    },
    {
      question: t("publicPresence.compare.faq.keepMore.question", values),
      answer: t("publicPresence.compare.faq.keepMore.answer", values),
    },
    {
      question: t("publicPresence.faq.launch.question"),
      answer: t("publicPresence.faq.launch.answer", launchTimeline),
    },
  ] as const;
}

function normalizeOrigin(origin: string) {
  return origin.replace(/\/+$/, "");
}

function comparePageUrl(competitor: FeeComparisonCompetitor, publicOrigin: string) {
  return `${normalizeOrigin(publicOrigin)}/compare/${competitor}`;
}

export function buildCompareStructuredData(
  competitor: FeeComparisonCompetitor,
  publicOrigin = "https://chasesets.com",
) {
  const origin = normalizeOrigin(publicOrigin);
  const homeUrl = `${origin}/`;
  const pageUrl = comparePageUrl(competitor, publicOrigin);
  const keys = compareMetaKeys[competitor];

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${pageUrl}#webpage`,
        name: t(keys.metaTitleKey),
        description: t(keys.metaDescriptionKey),
        url: pageUrl,
        isPartOf: {
          "@type": "WebSite",
          "@id": `${homeUrl}#website`,
          name: t("publicPresence.brand"),
          url: homeUrl,
        },
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${pageUrl}#breadcrumbs`,
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: t("publicPresence.brand"),
            item: homeUrl,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: t(competitorKey(competitor, "title")),
            item: pageUrl,
          },
        ],
      },
      {
        "@type": "FAQPage",
        "@id": `${pageUrl}#faq`,
        mainEntity: buildCompareFaqEntries(competitor).map((entry) => ({
          "@type": "Question",
          name: entry.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: entry.answer,
          },
        })),
      },
    ],
  } as const;
}

const chaseSetsCellKeys = [
  ["publicPresence.compare.row.processing", "publicPresence.compare.chaseSets.processing"],
  ["publicPresence.compare.row.feeLock", "publicPresence.compare.chaseSets.feeLock"],
  ["publicPresence.compare.row.protection", "publicPresence.compare.chaseSets.protection"],
  ["publicPresence.compare.row.payouts", "publicPresence.compare.chaseSets.payouts"],
  ["publicPresence.compare.row.coverage", "publicPresence.compare.chaseSets.coverage"],
  ["publicPresence.compare.row.availability", "publicPresence.compare.chaseSets.availability"],
] as const;

const competitorCellSuffixes = ["processing", "feeLock", "protection", "payouts", "coverage", "availability"] as const;

export function ComparePage({
  competitor,
  feeSchedule,
}: {
  competitor: FeeComparisonCompetitor;
  feeSchedule: PublicMarketplaceFeeSchedule | null;
}) {
  const competitorName = t(competitorNameKeys[competitor]);
  const values = competitorValues(competitor);
  const otherCompetitor: FeeComparisonCompetitor = competitor === "tcgplayer" ? "ebay" : "tcgplayer";

  // Truth gate: the Chase Sets fee cell only shows numbers from the live
  // published schedule; without it the cell points at the published
  // schedule page instead of showing stale or invented numbers.
  const chaseSetsFeeCell = feeSchedule
    ? t("publicPresence.compare.chaseSets.sellerFees.live", {
        rate: formatBpsPercent(feeSchedule.percentageBps),
        fixed: formatMoney(feeSchedule.fixedAmount, "USD"),
        cap: formatMoney(feeSchedule.capAmount, "USD"),
      })
    : t("publicPresence.compare.chaseSets.sellerFees.fallback");

  const rows = [
    [t("publicPresence.compare.row.sellerFees"), chaseSetsFeeCell, t(competitorKey(competitor, "sellerFees"), values)],
    ...chaseSetsCellKeys.map(([rowKey, chaseSetsKey], index) => [
      t(rowKey),
      t(chaseSetsKey, launchTimeline),
      t(competitorKey(competitor, competitorCellSuffixes[index]), values),
    ]),
  ];

  return (
    <PublicPresencePageShell>
      <Page>
        <PageHeader
          eyebrow={t("publicPresence.compare.eyebrow")}
          title={t(competitorKey(competitor, "title"))}
          description={t(competitorKey(competitor, "description"), values)}
        />
        <PageSection
          data-public-presence-section="compare_table"
          title={t("publicPresence.compare.table.title", values)}
          description={t("publicPresence.compare.table.description", values)}
        >
          <Table
            caption={t("publicPresence.compare.table.caption", values)}
            columns={[
              t("publicPresence.compare.table.column.dimension"),
              t("publicPresence.home.feeCalculator.column.chaseSets"),
              competitorName,
            ]}
            rows={rows}
          />
        </PageSection>
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <Surface elevated>
            <Stack gap={3}>
              <Heading level={2}>{t("publicPresence.compare.why.title")}</Heading>
              <Text tone="secondary">{t("publicPresence.compare.why.body")}</Text>
            </Stack>
          </Surface>
          <Surface elevated>
            <Stack gap={3}>
              <Heading level={2}>{t("publicPresence.compare.honesty.title", values)}</Heading>
              <Text tone="secondary">{t(competitorKey(competitor, "honesty.body"), values)}</Text>
            </Stack>
          </Surface>
        </Grid>
        <FeeCalculatorSection schedule={feeSchedule} compareLinks={[otherCompetitor]} />
        <PageSection data-public-presence-section="compare_faq" title={t("publicPresence.compare.faq.title")}>
          <ProgressiveDisclosureGroup
            items={buildCompareFaqEntries(competitor).map((entry, index) => ({
              value: compareFaqItemValues[index],
              title: entry.question,
              content: entry.answer,
            }))}
          />
        </PageSection>
        <Surface tone="subtle">
          <Stack gap={3}>
            <Text tone="secondary">{t("publicPresence.compare.cta.text", launchTimeline)}</Text>
            <Inline gap={2}>
              <LinkButton
                href="/#waitlist-form"
                tone="primary"
                onClick={() =>
                  trackWaitlistEvent("cta_clicked", { section: `compare_${competitor}`, target: "waitlist_form" })
                }
              >
                {t("publicPresence.nav.waitlist")}
              </LinkButton>
              <LinkButton href="/sales-fees" tone="secondary">
                {t("publicPresence.nav.sellerFees")}
              </LinkButton>
            </Inline>
          </Stack>
        </Surface>
        <Text size="sm" tone="tertiary">
          {t("publicPresence.compare.sourcesNote", values)}
        </Text>
      </Page>
    </PublicPresencePageShell>
  );
}
