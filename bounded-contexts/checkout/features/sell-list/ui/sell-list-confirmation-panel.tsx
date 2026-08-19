import { formatDateTime, t } from "@chase-sets/localization";
import {
  Badge,
  Grid,
  Inline,
  Inset,
  KeyValueList,
  LinkButton,
  MarketplaceNotice,
  PageSection,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type { CheckoutSellListConfirmationRow } from "../read-model/queries";
import { sellListConfirmationSupportReference } from "../read-model/support-reference";
import {
  confirmationReferenceSummary,
  formatStatus,
  lineOutcomeDisplayStatus,
  sideEffectTone,
} from "./sell-list-formatting";

export function LatestSellListConfirmationPanel({
  confirmation,
}: {
  confirmation: CheckoutSellListConfirmationRow | null;
}) {
  if (!confirmation) {
    return null;
  }

  const summary = confirmation.handoff_summary;
  const lineOutcomes = Array.isArray(summary.lineOutcomes) ? summary.lineOutcomes : [];
  const sideEffects = summary.sideEffects ?? {};
  const supportReference = sellListConfirmationSupportReference(confirmation.confirmation_id);
  const sideEffectRows = [
    { key: "sale", label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.sale") },
    {
      key: "accountHistory",
      label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.account.history"),
    },
    { key: "label", label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.label") },
    { key: "payout", label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.payout") },
    {
      key: "settlement",
      label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.settlement"),
    },
    {
      key: "notification",
      label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.notification"),
    },
  ] as const;

  return (
    <PageSection title={t("checkout.features.sellList.ui.sellListPage.latest.confirmation.title")}>
      <Surface elevation="tinted">
        <Stack gap={4}>
          <MarketplaceNotice
            tone="info"
            title={t("checkout.features.sellList.ui.sellListPage.latest.confirmation.notice.title")}
            description={t("checkout.features.sellList.ui.sellListPage.latest.confirmation.notice.description")}
          />
          <Grid columns={{ base: 1, md: 4 }} gap={3}>
            <Stack gap={1}>
              <Text size="sm" tone="secondary">
                {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.reference")}
              </Text>
              <Text weight="semibold" wrap="anywhere">
                {supportReference}
              </Text>
            </Stack>
            <Stack gap={1}>
              <Text size="sm" tone="secondary">
                {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.recorded")}
              </Text>
              <Text>{formatDateTime(confirmation.confirmed_at)}</Text>
            </Stack>
            <Stack gap={1}>
              <Text size="sm" tone="secondary">
                {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.accepted.offers")}
              </Text>
              <Text weight="semibold">{summary.acceptedOfferCount ?? 0}</Text>
            </Stack>
            <Stack gap={1}>
              <Text size="sm" tone="secondary">
                {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.listings.published")}
              </Text>
              <Text weight="semibold">{summary.publishedListingCount ?? 0}</Text>
            </Stack>
          </Grid>

          <Grid columns={{ base: 1, md: 3 }} gap={2}>
            {sideEffectRows.map((entry) => {
              const status = sideEffects[entry.key] ?? "not-attempted";
              return (
                <Inset key={entry.key} padding={3}>
                  <Inline gap={2}>
                    <Text weight="semibold">{entry.label}</Text>
                    <Badge tone={sideEffectTone(status)}>{formatStatus(status)}</Badge>
                  </Inline>
                </Inset>
              );
            })}
          </Grid>

          {lineOutcomes.length > 0 ? (
            <Stack gap={3}>
              <Text weight="semibold">
                {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.line.outcomes")}
              </Text>
              {lineOutcomes.map((outcome) => {
                const displayStatus = lineOutcomeDisplayStatus(outcome, sideEffects);
                return (
                  <Inset key={outcome.lineId} padding={3}>
                    <Grid columns={{ base: 1, md: 3 }} gap={3}>
                      <Stack gap={1}>
                        <Inline gap={2}>
                          <Badge tone={sideEffectTone(displayStatus)}>{formatStatus(displayStatus)}</Badge>
                          <Text weight="semibold" wrap="anywhere">
                            {outcome.itemTitle}
                          </Text>
                        </Inline>
                        <Text size="sm" tone="secondary">
                          {outcome.detail}
                        </Text>
                      </Stack>
                      <KeyValueList
                        density="compact"
                        variant="plain"
                        items={[
                          {
                            key: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.action"),
                            value: formatStatus(outcome.action),
                          },
                          {
                            key: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.quantity"),
                            value: outcome.quantity,
                          },
                          {
                            key: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.remaining"),
                            value: outcome.remainingQuantity,
                          },
                        ]}
                      />
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">
                          {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.support.references")}
                        </Text>
                        <Text wrap="anywhere">{confirmationReferenceSummary(outcome)}</Text>
                      </Stack>
                    </Grid>
                  </Inset>
                );
              })}
            </Stack>
          ) : null}

          <Inline gap={2}>
            <LinkButton href="/account/sell-list">
              {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.view.seller.activity")}
            </LinkButton>
            <LinkButton href="/account/sales" tone="secondary">
              {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.view.committed.sales")}
            </LinkButton>
            <LinkButton href="/account/sales/shipments" tone="secondary">
              {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.view.sale.shipments")}
            </LinkButton>
            <LinkButton href="/account/support" tone="secondary">
              {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.open.support")}
            </LinkButton>
          </Inline>
        </Stack>
      </Surface>
    </PageSection>
  );
}
