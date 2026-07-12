import { t } from "@chase-sets/localization";
import {
  Badge,
  DataTable,
  LinkText,
  Page,
  PageHeader,
  PageSection,
  Stat,
  StatGrid,
  Stack,
  TaskProgress,
  Text,
} from "@chase-sets/design-system";
import type { WaitlistGame, WaitlistInventorySize } from "../domain/common";
import { WAITLIST_GAMES, WAITLIST_INVENTORY_SIZES } from "../domain/common";
import type { CampaignAnalyticsSnapshot } from "../api/contracts";
import { WAVE_ONE_ADMISSION_BAR } from "../read-model/campaign-admission-bar-policy";

function progressPercent(count: number, goal: number) {
  return goal > 0 ? Math.min(100, (count / goal) * 100) : 100;
}

const gameLabelKeys: Record<WaitlistGame, string> = {
  pokemon: "publicPresence.waitlist.game.pokemon",
  "magic-the-gathering": "publicPresence.waitlist.game.magicTheGathering",
  "yu-gi-oh": "publicPresence.waitlist.game.yuGiOh",
  "disney-lorcana": "publicPresence.waitlist.game.disneyLorcana",
  "one-piece-card-game": "publicPresence.waitlist.game.onePieceCardGame",
};

const inventorySizeLabelKeys: Record<WaitlistInventorySize, string> = {
  under_100: "publicPresence.waitlist.inventorySize.under100",
  "100_to_500": "publicPresence.waitlist.inventorySize.100to500",
  "500_to_2000": "publicPresence.waitlist.inventorySize.500to2000",
  "2000_plus": "publicPresence.waitlist.inventorySize.2000plus",
};

function channelLabel(
  row: Readonly<{ utm_source: string | null; utm_medium: string | null; utm_campaign: string | null }>,
) {
  if (!row.utm_source && !row.utm_medium && !row.utm_campaign) {
    return t("publicPresence.admin.campaignAnalytics.channel.direct");
  }
  return [row.utm_source, row.utm_medium, row.utm_campaign].filter(Boolean).join(" / ");
}

export function CampaignAnalyticsPage({
  analytics,
  funnelDashboardHref,
}: {
  analytics: CampaignAnalyticsSnapshot;
  funnelDashboardHref: string;
}) {
  const { quality, channelAttribution, admissionBar } = analytics;

  return (
    <Page>
      <PageHeader
        eyebrow={t("publicPresence.admin.eyebrow")}
        title={t("publicPresence.admin.campaignAnalytics.title")}
        description={t("publicPresence.admin.campaignAnalytics.description")}
      />

      <PageSection
        title={t("publicPresence.admin.campaignAnalytics.admissionBar.title")}
        description={t("publicPresence.admin.campaignAnalytics.admissionBar.description")}
      >
        <Stack gap={4}>
          <Badge tone={admissionBar.admitted ? "success" : "neutral"}>
            {admissionBar.admitted
              ? t("publicPresence.admin.campaignAnalytics.admissionBar.status.admitted")
              : t("publicPresence.admin.campaignAnalytics.admissionBar.status.notAdmitted")}
          </Badge>
          <TaskProgress
            label={t("publicPresence.admin.campaignAnalytics.admissionBar.totalSignups")}
            value={progressPercent(admissionBar.totalSignups, WAVE_ONE_ADMISSION_BAR.minTotalSignups)}
            valueLabel={t("publicPresence.admin.campaignAnalytics.admissionBar.progressValue", {
              count: admissionBar.totalSignups,
              goal: WAVE_ONE_ADMISSION_BAR.minTotalSignups,
            })}
            tone={admissionBar.totalSignupsMet ? "success" : "accent"}
          />
          <TaskProgress
            label={t("publicPresence.admin.campaignAnalytics.admissionBar.qualifiedSellers")}
            value={progressPercent(admissionBar.qualifiedSellerCount, WAVE_ONE_ADMISSION_BAR.minQualifiedSellers)}
            valueLabel={t("publicPresence.admin.campaignAnalytics.admissionBar.progressValue", {
              count: admissionBar.qualifiedSellerCount,
              goal: WAVE_ONE_ADMISSION_BAR.minQualifiedSellers,
            })}
            tone={admissionBar.qualifiedSellersMet ? "success" : "accent"}
          />
        </Stack>
      </PageSection>

      <StatGrid columns={{ base: 1, md: 4 }}>
        <Stat label={t("publicPresence.admin.campaignAnalytics.stat.totalSignups")} value={quality.totalSignups} />
        <Stat
          label={t("publicPresence.admin.campaignAnalytics.stat.sellerSignups")}
          value={quality.sellerSignupCount}
        />
        <Stat
          label={t("publicPresence.admin.campaignAnalytics.stat.qualifiedSellers")}
          value={quality.qualifiedSellerCount}
        />
        <Stat
          label={t("publicPresence.admin.campaignAnalytics.stat.storeLinkPercent")}
          value={`${quality.storeLinkPercent}%`}
        />
      </StatGrid>

      <PageSection
        title={t("publicPresence.admin.campaignAnalytics.gameCoverage.title")}
        description={t("publicPresence.admin.campaignAnalytics.gameCoverage.description")}
      >
        <DataTable<(typeof admissionBar.gameCoverage)[number]>
          columns={[
            {
              key: "game",
              header: t("publicPresence.admin.campaignAnalytics.gameCoverage.game"),
              cell: (row) => t(gameLabelKeys[row.game]),
            },
            {
              key: "qualifiedSellerCount",
              header: t("publicPresence.admin.campaignAnalytics.gameCoverage.qualifiedSellers"),
              cell: (row) => row.qualifiedSellerCount,
            },
            {
              key: "covered",
              header: t("publicPresence.admin.campaignAnalytics.gameCoverage.covered"),
              cell: (row) => (
                <Badge tone={row.covered ? "success" : "neutral"}>
                  {row.covered
                    ? t("publicPresence.admin.campaignAnalytics.gameCoverage.covered.yes")
                    : t("publicPresence.admin.campaignAnalytics.gameCoverage.covered.no")}
                </Badge>
              ),
            },
          ]}
          rows={[...admissionBar.gameCoverage]}
          getRowId={(row) => row.game}
          emptyTitle={t("publicPresence.admin.campaignAnalytics.gameCoverage.emptyTitle")}
          emptyDescription={t("publicPresence.admin.campaignAnalytics.gameCoverage.emptyDescription")}
        />
      </PageSection>

      <PageSection title={t("publicPresence.admin.campaignAnalytics.inventorySize.title")}>
        <StatGrid columns={{ base: 2, md: 4 }}>
          {WAITLIST_INVENTORY_SIZES.map((size) => (
            <Stat
              key={size}
              label={t(inventorySizeLabelKeys[size])}
              value={quality.inventorySizeDistribution[size] ?? 0}
            />
          ))}
        </StatGrid>
      </PageSection>

      <PageSection
        title={t("publicPresence.admin.campaignAnalytics.channelAttribution.title")}
        description={t("publicPresence.admin.campaignAnalytics.channelAttribution.description")}
      >
        <DataTable<CampaignAnalyticsSnapshot["channelAttribution"][number]>
          columns={[
            {
              key: "channel",
              header: t("publicPresence.admin.campaignAnalytics.channelAttribution.channel"),
              cell: (row) => channelLabel(row),
            },
            {
              key: "signup_count",
              header: t("publicPresence.admin.campaignAnalytics.channelAttribution.signups"),
              cell: (row) => row.signup_count,
            },
            {
              key: "seller_signup_count",
              header: t("publicPresence.admin.campaignAnalytics.channelAttribution.sellerSignups"),
              cell: (row) => row.seller_signup_count,
            },
            {
              key: "qualified_seller_count",
              header: t("publicPresence.admin.campaignAnalytics.channelAttribution.qualifiedSellers"),
              cell: (row) => row.qualified_seller_count,
            },
          ]}
          rows={[...channelAttribution]}
          getRowId={(row) => `${row.utm_source ?? ""}::${row.utm_medium ?? ""}::${row.utm_campaign ?? ""}`}
          emptyTitle={t("publicPresence.admin.campaignAnalytics.channelAttribution.emptyTitle")}
          emptyDescription={t("publicPresence.admin.campaignAnalytics.channelAttribution.emptyDescription")}
        />
      </PageSection>

      <PageSection
        title={t("publicPresence.admin.campaignAnalytics.funnel.title")}
        description={t("publicPresence.admin.campaignAnalytics.funnel.description")}
      >
        <Text>
          <LinkText href={funnelDashboardHref} target="_blank" rel="noopener noreferrer">
            {t("publicPresence.admin.campaignAnalytics.funnel.link")}
          </LinkText>
        </Text>
      </PageSection>
    </Page>
  );
}
