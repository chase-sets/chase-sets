import { formatDate, formatMoney, t } from "@chase-sets/localization";
import { useState } from "react";
import {
  AccountReputationSummary,
  Badge,
  BulkActionBar,
  Button,
  Checkbox,
  Grid,
  Inline,
  LinkButton,
  MarketplaceEmptyState,
  MarketplaceNotice,
  OfferCard,
  Page,
  PageHeader,
  PageSection,
  ProductOptions,
  SegmentedControl,
  Stack,
  Text,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type {
  SubmittedOfferListItem,
  SubmittedOfferStatus,
  SubmittedOfferStatusCounts,
  SubmittedOfferStatusFilter,
} from "./contracts";
import type { BuyerOfferPolicySnapshot } from "../../../client";
import { MarketFollowingOfferControls } from "./submitted-offer-detail-page";
import {
  latestSubmittedOfferStatus,
  submittedOfferLifecycleActions,
  submittedOfferStatusFilters,
  submittedOfferStatusLabel,
  submittedOfferStatusTone,
  SubmittedOfferLifecycleOutcomes,
  WithdrawOfferConfirmation,
  type SubmittedOfferLifecycleControls,
} from "./submitted-offer-lifecycle";

function statusFilterLabel(filter: SubmittedOfferStatusFilter, counts: SubmittedOfferStatusCounts) {
  const count =
    filter === "all"
      ? Object.values(counts).reduce((sum, value) => sum + value, 0)
      : counts[filter as SubmittedOfferStatus];
  return t(`marketplace.features.offers.ui.submittedOfferLifecycle.filter.${filter}`, { count });
}

export function MarketplaceSubmittedOfferListPage({
  data,
  errorMessage,
  policies,
  statusFilter = "all",
  onStatusFilterChange,
  lifecycle,
}: {
  data: { items: readonly SubmittedOfferListItem[]; statusCounts?: SubmittedOfferStatusCounts };
  errorMessage?: string | null;
  policies?: readonly BuyerOfferPolicySnapshot[];
  statusFilter?: SubmittedOfferStatusFilter;
  onStatusFilterChange?: (filter: SubmittedOfferStatusFilter) => void;
  lifecycle?: SubmittedOfferLifecycleControls;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [withdrawing, setWithdrawing] = useState<readonly string[] | null>(null);
  const selectedIds = data.items.map((offer) => offer.offer_id).filter((offerId) => selected.has(offerId));
  const titles = new Map(data.items.map((offer) => [offer.offer_id, offer.item_title]));
  const run: SubmittedOfferLifecycleControls["onAction"] = (action, offerIds) => {
    if (!lifecycle || lifecycle.pending || offerIds.length === 0) return;
    lifecycle.onAction(action, offerIds);
  };
  const toggle = (offerId: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(offerId);
      else next.delete(offerId);
      return next;
    });

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.offers.ui.submittedOfferListPage.offers")}
        title={t("marketplace.features.offers.ui.submittedOfferListPage.submitted.offers")}
        description={t("marketplace.features.offers.ui.submittedOfferListPage.review.the.offers.your.account.has")}
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
          title={t("marketplace.features.offers.ui.submittedOfferListPage.offer.status.issue")}
          description={errorMessage}
        />
      ) : null}

      {policies ? <MarketFollowingOfferControls offers={data.items} policies={policies} /> : null}
      <PageSection title={t("marketplace.features.offers.ui.submittedOfferListPage.submitted.offers.2")}>
        <Stack gap={3}>
          {data.statusCounts ? (
            <SegmentedControl
              label={t("marketplace.features.offers.ui.submittedOfferLifecycle.status.filter")}
              value={statusFilter}
              items={submittedOfferStatusFilters.map((filter) => ({
                value: filter,
                label: statusFilterLabel(filter, data.statusCounts!),
              }))}
              onValueChange={(value) => onStatusFilterChange?.(value as SubmittedOfferStatusFilter)}
            />
          ) : null}
          {lifecycle?.pending ? (
            <Text size="sm" tone="secondary">
              {t("marketplace.features.offers.ui.submittedOfferLifecycle.pending")}
            </Text>
          ) : null}
          <SubmittedOfferLifecycleOutcomes outcomes={lifecycle?.outcomes ?? null} titles={titles} />
          {data.items.length === 0 ? (
            statusFilter === "all" ? (
              <MarketplaceEmptyState
                title={t("marketplace.features.offers.ui.submittedOfferListPage.no.submitted.offers.yet")}
                description={t("marketplace.features.offers.ui.submittedOfferListPage.submit.an.offer.from.any.item")}
                recoveryActions={
                  <LinkButton href="/" tone="secondary">
                    {t("marketplace.features.offers.ui.submittedOfferListPage.browse.marketplace")}
                  </LinkButton>
                }
              />
            ) : (
              <MarketplaceEmptyState
                title={t(`marketplace.features.offers.ui.submittedOfferLifecycle.empty.${statusFilter}`)}
                description={t("marketplace.features.offers.ui.submittedOfferLifecycle.empty.description")}
              />
            )
          ) : (
            <Grid columns={{ base: 1, xl: 2 }} gap={3}>
              {data.items.map((offer) => {
                const status = latestSubmittedOfferStatus(offer, lifecycle?.outcomes ?? null);
                return (
                  <OfferCard
                    key={offer.offer_id}
                    title={offer.item_title}
                    amount={
                      offer.price_currency_code
                        ? formatMoney(offer.price_amount, offer.price_currency_code)
                        : t("marketplace.features.offers.ui.price.incomplete")
                    }
                    status={<Badge tone={submittedOfferStatusTone(status)}>{submittedOfferStatusLabel(status)}</Badge>}
                    details={
                      <Stack gap={2}>
                        {offer.item_subtitle ? <Text size="sm">{offer.item_subtitle}</Text> : null}
                        {offer.product_summary ? (
                          <ProductOptions options={productOptionsFromSummary(offer.product_summary)} variant="chips" />
                        ) : null}
                        <Text size="sm" tone="secondary">
                          {t("marketplace.features.offers.ui.submittedOfferListPage.quantity.requested", {
                            quantity: offer.quantity_requested,
                          })}
                        </Text>
                        {offer.accepted_seller_account_id && offer.status === "accepted" ? (
                          <AccountReputationSummary
                            accountName={offer.accepted_seller_account_id}
                            averageRating={offer.accepted_seller_average_rating}
                            reviewCount={offer.accepted_seller_review_count ?? 0}
                            ratingLabel={t("marketplace.features.offers.ui.submittedOfferListPage.seller.reputation")}
                          />
                        ) : null}
                        <Text size="sm" tone="secondary">
                          {t("marketplace.features.offers.ui.submittedOfferListPage.updated.on", {
                            date: formatDate(offer.updated_at),
                          })}
                        </Text>
                      </Stack>
                    }
                    actions={
                      <Inline gap={2}>
                        {lifecycle ? (
                          <Checkbox
                            label={t("marketplace.features.offers.ui.submittedOfferLifecycle.select.row", {
                              title: offer.item_title,
                            })}
                            checked={selected.has(offer.offer_id)}
                            onCheckedChange={(checked) => toggle(offer.offer_id, checked === true)}
                          />
                        ) : null}
                        <LinkButton href={`/account/offers/submitted/${offer.offer_id}`} tone="secondary" size="sm">
                          {t("marketplace.features.offers.ui.submittedOfferListPage.open")}
                        </LinkButton>
                        {lifecycle
                          ? submittedOfferLifecycleActions(status).map((action) => (
                              <Button
                                key={action}
                                size="sm"
                                tone="secondary"
                                disabled={lifecycle.pending}
                                aria-label={t(`marketplace.features.offers.ui.submittedOfferLifecycle.${action}.row`, {
                                  title: offer.item_title,
                                })}
                                onClick={() =>
                                  action === "withdraw"
                                    ? setWithdrawing([offer.offer_id])
                                    : run(action, [offer.offer_id])
                                }
                              >
                                {t(`marketplace.features.offers.ui.submittedOfferLifecycle.${action}`)}
                              </Button>
                            ))
                          : null}
                      </Inline>
                    }
                  />
                );
              })}
            </Grid>
          )}
          {lifecycle && selectedIds.length > 0 ? (
            <BulkActionBar
              count={selectedIds.length}
              formatSelectedLabel={(count) =>
                t("marketplace.features.offers.ui.submittedOfferLifecycle.bulk.selected", { count })
              }
              primaryActions={
                <Inline gap={2} align="end">
                  <Button size="sm" disabled={lifecycle.pending} onClick={() => run("pause", selectedIds)}>
                    {t("marketplace.features.offers.ui.submittedOfferLifecycle.bulk.pause")}
                  </Button>
                  <Button size="sm" disabled={lifecycle.pending} onClick={() => run("resume", selectedIds)}>
                    {t("marketplace.features.offers.ui.submittedOfferLifecycle.bulk.resume")}
                  </Button>
                  <Button
                    size="sm"
                    tone="secondary"
                    disabled={lifecycle.pending}
                    onClick={() => setWithdrawing(selectedIds)}
                  >
                    {t("marketplace.features.offers.ui.submittedOfferLifecycle.bulk.withdraw")}
                  </Button>
                </Inline>
              }
              secondaryActions={
                <Button size="sm" tone="secondary" onClick={() => setSelected(new Set())}>
                  {t("marketplace.features.offers.ui.submittedOfferLifecycle.bulk.clear")}
                </Button>
              }
            />
          ) : null}
        </Stack>
      </PageSection>
      <WithdrawOfferConfirmation
        offerIds={withdrawing}
        onCancel={() => setWithdrawing(null)}
        onConfirm={(offerIds) => {
          setWithdrawing(null);
          run("withdraw", offerIds);
        }}
      />
    </Page>
  );
}
