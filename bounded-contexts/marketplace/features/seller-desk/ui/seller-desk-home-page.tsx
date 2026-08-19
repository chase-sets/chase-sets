import {
  Badge,
  Banner,
  Card,
  Cluster,
  EmptyState,
  Inline,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stat,
  StatGrid,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { SellerAttentionItem, SellerAttentionQueue } from "@chase-sets/seller-attention-queue";
import type { SellerDeskKpis } from "./contracts";
import {
  attentionActionLabel,
  attentionSourceLabel,
  resolveAttentionSummary,
  severityLabel,
  severityTone,
} from "./seller-desk-summary";

// The Seller Desk home — the seller's landing surface. It answers "what needs
// me, most important first" with the attention queue (already ordered by the
// blueprint's `compareSellerAttentionItems` inside the read model) and describes
// the business with the KPI band. Every queue row deep-links straight into the
// entity that needs work; when nothing needs the seller the zero-state is calm.
// The page reads only design-system components and consumes the read-model
// contract directly — no custom UI, no re-declared ordering.
export type SellerDeskHomePageProps = Readonly<{
  queue: SellerAttentionQueue;
  kpis: SellerDeskKpis;
}>;

export function SellerDeskHomePage({ queue, kpis }: SellerDeskHomePageProps) {
  const unavailableSources = queue.sources.filter((source) => source.status === "unavailable");

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.sellerDesk.eyebrow")}
        title={t("marketplace.features.sellerDesk.title")}
        description={t("marketplace.features.sellerDesk.description")}
      />

      <PageSection title={t("marketplace.features.sellerDesk.kpis.title")}>
        <StatGrid columns={{ base: 1, sm: 2, lg: 4 }}>
          <Stat
            label={t("marketplace.features.sellerDesk.kpis.activeListings")}
            value={formatCount(kpis.activeListings)}
            icon="store"
          />
          <Stat
            label={t("marketplace.features.sellerDesk.kpis.openOrdersToShip")}
            value={formatCount(kpis.openOrdersToShip)}
            icon="truck"
          />
          <Stat
            label={t("marketplace.features.sellerDesk.kpis.nextPayout")}
            value={formatAmount(kpis.nextPayoutAmount)}
            icon="wallet"
          />
          <Stat
            label={t("marketplace.features.sellerDesk.kpis.walletBalance")}
            value={formatAmount(kpis.walletBalanceAmount)}
            icon="wallet"
          />
        </StatGrid>
      </PageSection>

      <PageSection
        title={t("marketplace.features.sellerDesk.queue.title")}
        description={t("marketplace.features.sellerDesk.queue.description")}
      >
        <Stack gap={4}>
          <Inline>
            <Badge tone={queue.rollup.total > 0 ? severityTone(highestSeverity(queue)) : "success"}>
              {t("marketplace.features.sellerDesk.queue.count", { count: queue.rollup.total })}
            </Badge>
          </Inline>

          {unavailableSources.length > 0 ? (
            <Banner
              tone="warning"
              data-seller-desk-degraded="true"
              title={t("marketplace.features.sellerDesk.degraded.title")}
              description={
                <Stack gap={1}>
                  <Text size="sm" tone="inherit">
                    {t("marketplace.features.sellerDesk.degraded.description")}
                  </Text>
                  {unavailableSources.map((source) => (
                    <Text key={source.id} size="sm" tone="inherit">
                      {t("marketplace.features.sellerDesk.degraded.source", {
                        source: attentionSourceLabel(source.id),
                        reason: source.reason ?? t("marketplace.features.sellerDesk.degraded.reasonUnknown"),
                      })}
                    </Text>
                  ))}
                </Stack>
              }
            />
          ) : null}

          {queue.items.length === 0 ? (
            <EmptyState
              title={t("marketplace.features.sellerDesk.empty.title")}
              description={t("marketplace.features.sellerDesk.empty.description")}
              actions={
                <Inline>
                  <LinkButton href="/account/listings/new" tone="primary">
                    {t("marketplace.features.sellerDesk.empty.createListing")}
                  </LinkButton>
                  <LinkButton href="/account/inventory" tone="secondary">
                    {t("marketplace.features.sellerDesk.empty.viewInventory")}
                  </LinkButton>
                </Inline>
              }
            />
          ) : (
            <Stack gap={3} data-seller-desk-queue="true">
              {queue.items.map((item) => (
                <SellerDeskQueueRow key={item.id} item={item} />
              ))}
            </Stack>
          )}
        </Stack>
      </PageSection>

      <PageSection title={t("marketplace.features.sellerDesk.surfaces.title")}>
        <Inline>
          <LinkButton href="/account/listings" tone="secondary">
            {t("marketplace.features.sellerDesk.surfaces.listings")}
          </LinkButton>
          <LinkButton href="/account/offers/matches" tone="secondary">
            {t("marketplace.features.sellerDesk.surfaces.offers")}
          </LinkButton>
          <LinkButton href="/account/sales/shipments" tone="secondary">
            {t("marketplace.features.sellerDesk.surfaces.shipments")}
          </LinkButton>
          <LinkButton href="/account/payouts" tone="secondary">
            {t("marketplace.features.sellerDesk.surfaces.payouts")}
          </LinkButton>
          <LinkButton href="/account/inventory" tone="secondary">
            {t("marketplace.features.sellerDesk.surfaces.inventory")}
          </LinkButton>
        </Inline>
      </PageSection>
    </Page>
  );
}

function SellerDeskQueueRow({ item }: { item: SellerAttentionItem }) {
  return (
    <Card elevation="outlined" data-seller-desk-item={item.id} data-seller-desk-severity={item.severity}>
      <Cluster>
        <Stack gap={1} align="start">
          <Inline>
            <Badge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Badge>
          </Inline>
          <Text weight="semibold">{resolveAttentionSummary(item)}</Text>
        </Stack>
        <LinkButton href={item.deepLink.href} tone="primary">
          {attentionActionLabel(item.source)}
        </LinkButton>
      </Cluster>
    </Card>
  );
}

// The highest severity present, used to tone the queue count badge. The rollup
// never lies (it is computed from exactly the rendered items), so a positive
// total always has at least one severity bucket populated.
function highestSeverity(queue: SellerAttentionQueue) {
  if (queue.rollup.bySeverity.critical > 0) {
    return "critical" as const;
  }
  if (queue.rollup.bySeverity.warning > 0) {
    return "warning" as const;
  }
  return "info" as const;
}

function formatCount(value: number | null): string {
  return value === null ? t("marketplace.features.sellerDesk.kpis.unavailable") : String(value);
}

function formatAmount(value: string | null): string {
  return value === null ? t("marketplace.features.sellerDesk.kpis.unavailable") : value;
}
