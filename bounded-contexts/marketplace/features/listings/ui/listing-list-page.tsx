import {
  formatBpsPercent,
  formatDateTime,
  formatLanguageCodeLabel,
  formatMoney as formatMoneyDisplay,
  t,
} from "@chase-sets/localization";
import { useState } from "react";
import {
  HiddenInput,
  Form,
  AppliedFilterChips,
  Badge,
  BulkActionBar,
  Button,
  Card,
  DataTable,
  FilterArea,
  Inline,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceNotice,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Pagination,
  ProgressiveDisclosure,
  ProductOptions,
  Stack,
  Text,
  TextInput,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type {
  MarketplaceListingBulkActionOutcome,
  MarketplaceListingFeeLockReportEntry,
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceSellerOrderCapacity,
  MarketplaceSellerListingStatusCounts,
} from "./contracts";
import type { SellerBehavioralMetricsSummary } from "../../../support/request-support/seller-metrics-client";
import { TimeAwayCapacityCard } from "./time-away-capacity-card";

const SELLER_LISTING_STATUS_FILTERS = ["all", "draft", "active", "paused", "withdrawn"] as const;

function formatMoney(amount: string | null) {
  if (!amount) {
    return t("marketplace.features.listings.ui.listingListPage.not.set");
  }

  return formatMoneyDisplay(amount, "USD");
}

function statusTone(status: string) {
  switch (status) {
    case "active":
      return "accent";
    case "paused":
      return "warning";
    case "withdrawn":
      return "danger";
    default:
      return "neutral";
  }
}

function renderFeeSummary(listing: MarketplaceListingListItem) {
  if (!listing.marketplace_sales_fee_unit_amount && !listing.seller_net_unit_amount) {
    return t("marketplace.features.listings.ui.listingListPage.fee.quote.unavailable");
  }

  const segments = [
    t("marketplace.features.listings.ui.listingListPage.marketplace.fee.summary", {
      amount: formatMoney(listing.marketplace_sales_fee_unit_amount),
    }),
    t("marketplace.features.listings.ui.listingListPage.net.summary", {
      amount: formatMoney(listing.seller_net_unit_amount),
    }),
    t("marketplace.features.listings.ui.listingListPage.buyer.shipping.credit.summary", {
      percentage: formatBpsPercent(listing.shipping_allowance_percentage_bps),
    }),
  ];

  return segments.join(". ");
}

function termsSource(row: MarketplaceListingFeeLockReportEntry) {
  if (row.terms_agreement_id) {
    return "Seller terms";
  }

  return row.terms_schedule_id
    ? "Standard seller terms"
    : t("marketplace.features.listings.ui.listingListPage.source.unavailable");
}

function formatTimestamp(value: string | null) {
  return value ? formatDateTime(value) : t("marketplace.features.listings.ui.listingListPage.not.set");
}

// The own-account seller-metrics read is never N-gated (see the prop doc
// comment below), but a brand-new seller's denominator is legitimately
// zero -- the rate column is null, not a misleading 0%.
function formatBehavioralMetricRate(rate: string | null) {
  if (rate === null) {
    return t("marketplace.features.listings.ui.listingListPage.not.enough.orders.yet");
  }

  // The rate is a 0-1 fraction; one basis point is 1/10000, so this renders
  // through the canonical percent formatter at the same 0.1% precision the
  // page always displayed.
  return formatBpsPercent(Number(rate) * 10_000, { maximumFractionDigits: 1 });
}

function navigateToListingListPage(page: number, pageSize: number) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("offset", String((page - 1) * pageSize));
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
}

function statusFilterLabel(status: string) {
  switch (status) {
    case "draft":
      return t("marketplace.features.listings.ui.listingListPage.status.filter.draft");
    case "active":
      return t("marketplace.features.listings.ui.listingListPage.status.filter.active");
    case "paused":
      return t("marketplace.features.listings.ui.listingListPage.status.filter.paused");
    case "withdrawn":
      return t("marketplace.features.listings.ui.listingListPage.status.filter.withdrawn");
    default:
      return t("marketplace.features.listings.ui.listingListPage.status.filter.all");
  }
}

function statusFilterItems() {
  return SELLER_LISTING_STATUS_FILTERS.map((status) => ({ value: status, label: statusFilterLabel(status) }));
}

function buildAppliedFilters(filters: { status: string; search: string }) {
  const applied: { id: string; label: string }[] = [];
  if (filters.search) {
    applied.push({
      id: "search",
      label: t("marketplace.features.listings.ui.listingListPage.search.filter.chip", { search: filters.search }),
    });
  }
  if (filters.status !== "all") {
    applied.push({
      id: "status",
      label: t("marketplace.features.listings.ui.listingListPage.status.filter.chip", {
        status: statusFilterLabel(filters.status),
      }),
    });
  }

  return applied;
}

export function MarketplaceListingListPage({
  data,
  statusCounts,
  pagination,
  feeLockReport,
  listingAvailability,
  orderCapacity,
  openOrderCount = null,
  filters = { status: "all", search: "" },
  bulkActionOutcomes,
  errorMessage,
  sellerBehavioralMetrics = null,
}: {
  data: { items: readonly MarketplaceListingListItem[] };
  statusCounts?: MarketplaceSellerListingStatusCounts;
  pagination?: Readonly<{ limit: number; offset: number; total: number }>;
  feeLockReport?: { items: readonly MarketplaceListingFeeLockReportEntry[] };
  listingAvailability: MarketplaceSellerListingAvailability;
  orderCapacity: MarketplaceSellerOrderCapacity;
  /** Ordering-sourced live Open Order count for the "N of M" display; null when that cross-context read was unavailable. Never counted client-side. */
  openOrderCount?: number | null;
  filters?: Readonly<{ status: string; search: string }>;
  bulkActionOutcomes?: readonly MarketplaceListingBulkActionOutcome[] | null;
  errorMessage?: string | null;
  /** The seller's own rolling-window behavioral metrics, own-account read only -- no display gating (a seller may always see their own raw counts). Null while unauthenticated/unavailable. */
  sellerBehavioralMetrics?: SellerBehavioralMetricsSummary | null;
}) {
  const [selectedListingIds, setSelectedListingIds] = useState<Set<string>>(new Set());
  const activeListings = statusCounts
    ? statusCounts.active
    : data.items.filter((item) => item.status === "active").length;
  const draftListings = statusCounts ? statusCounts.draft : data.items.filter((item) => item.status === "draft").length;
  const pausedListings = statusCounts
    ? statusCounts.paused
    : data.items.filter((item) => item.status === "paused").length;
  const withdrawnListings = statusCounts
    ? statusCounts.withdrawn
    : data.items.filter((item) => item.status === "withdrawn").length;
  const pageSize = pagination?.limit ?? data.items.length;
  const currentPage = pagination && pageSize > 0 ? Math.floor(pagination.offset / pageSize) + 1 : 1;
  const totalPages = pagination && pageSize > 0 ? Math.max(1, Math.ceil(pagination.total / pageSize)) : 1;
  const showPagination = Boolean(pagination && (pagination.total > pageSize || pagination.offset > 0));
  const appliedFilters = buildAppliedFilters(filters);
  const succeededOutcomeCount = bulkActionOutcomes?.filter((outcome) => outcome.outcome === "success").length ?? 0;
  const failedOutcomeCount = bulkActionOutcomes?.filter((outcome) => outcome.outcome === "error").length ?? 0;

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.listings.ui.listingListPage.seller")}
        title={t("marketplace.features.listings.ui.listingListPage.listings")}
        description={t("marketplace.features.listings.ui.listingListPage.create.publish.and.manage.seller.listings")}
        actions={
          <Inline>
            <LinkButton href="/account/listings/new">
              {t("marketplace.features.listings.ui.listingListPage.create.listing")}
            </LinkButton>
            <LinkButton href="/account/inventory/imports" tone="secondary">
              {t("marketplace.features.listings.ui.listingListPage.advanced.import")}
            </LinkButton>
          </Inline>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
          title={t("marketplace.features.listings.ui.listingListPage.listings")}
          description={errorMessage}
        />
      ) : null}

      <PageSection title={t("marketplace.features.listings.ui.listingListPage.time.away.and.order.capacity")}>
        <TimeAwayCapacityCard
          availability={listingAvailability}
          orderCapacity={orderCapacity}
          openOrderCount={openOrderCount}
          activeListingCount={activeListings}
        />
      </PageSection>

      <MarketplaceDashboardPanel
        title={t("marketplace.features.listings.ui.listingListPage.listing.health")}
        description={t("marketplace.features.listings.ui.listingListPage.track.active.supply.drafts.and.sellable")}
        metrics={[
          {
            label: t("marketplace.features.listings.ui.listingListPage.active.listings"),
            value: activeListings,
            detail: t("marketplace.features.listings.ui.listingListPage.visible.to.buyers"),
          },
          {
            label: t("marketplace.features.listings.ui.listingListPage.draft.listings"),
            value: draftListings,
            detail: t("marketplace.features.listings.ui.listingListPage.not.visible.yet"),
          },
          {
            label: t("marketplace.features.listings.ui.listingListPage.paused.listings"),
            value: pausedListings,
            detail: t("marketplace.features.listings.ui.listingListPage.paused.listings.detail"),
          },
          {
            label: t("marketplace.features.listings.ui.listingListPage.withdrawn.listings"),
            value: withdrawnListings,
            detail: t("marketplace.features.listings.ui.listingListPage.withdrawn.listings.detail"),
          },
        ]}
      />

      <MarketplaceDashboardPanel
        title={t("marketplace.features.listings.ui.listingListPage.seller.reliability")}
        description={t("marketplace.features.listings.ui.listingListPage.seller.reliability.description", {
          windowDays: sellerBehavioralMetrics?.window_days ?? 90,
        })}
        metrics={[
          {
            label: t("marketplace.features.listings.ui.listingListPage.on.time.shipment.rate"),
            value: formatBehavioralMetricRate(sellerBehavioralMetrics?.on_time_shipment_rate ?? null),
            detail: t("marketplace.features.listings.ui.listingListPage.on.time.shipment.rate.detail", {
              count: sellerBehavioralMetrics?.shipments_dispatched_count ?? 0,
            }),
          },
          {
            label: t("marketplace.features.listings.ui.listingListPage.cancellation.rate"),
            value: formatBehavioralMetricRate(sellerBehavioralMetrics?.cancellation_rate ?? null),
            detail: t("marketplace.features.listings.ui.listingListPage.cancellation.rate.detail", {
              count: sellerBehavioralMetrics?.orders_created_count ?? 0,
            }),
          },
          {
            label: t("marketplace.features.listings.ui.listingListPage.dispute.rate"),
            value: formatBehavioralMetricRate(sellerBehavioralMetrics?.dispute_rate ?? null),
            detail: t("marketplace.features.listings.ui.listingListPage.dispute.rate.detail", {
              count: sellerBehavioralMetrics?.orders_created_count ?? 0,
            }),
          },
        ]}
      />

      <PageSection title={t("marketplace.features.listings.ui.listingListPage.current.listings")}>
        <Stack gap={3}>
          <Form method="get" spacing="none">
            <FilterArea
              activeFilterCount={appliedFilters.length}
              panelTitle={t("marketplace.features.listings.ui.listingListPage.filters")}
              overflowTriggerLabel={t("marketplace.features.listings.ui.listingListPage.more.filters")}
              filters={[
                <TextInput
                  key="search"
                  label={t("marketplace.features.listings.ui.listingListPage.search.by.title")}
                  name="search"
                  defaultValue={filters.search}
                  placeholder={t("marketplace.features.listings.ui.listingListPage.search.by.title.placeholder")}
                />,
                <NativeSelect
                  key="status"
                  label={t("marketplace.features.listings.ui.listingListPage.status")}
                  name="status"
                  defaultValue={filters.status}
                  items={statusFilterItems()}
                />,
              ]}
              actions={
                <Inline>
                  <Button type="submit" leadingIcon="filter">
                    {t("marketplace.features.listings.ui.listingListPage.apply.filters")}
                  </Button>
                  <LinkButton href="/account/listings" tone="secondary">
                    {t("marketplace.features.listings.ui.listingListPage.clear.filters")}
                  </LinkButton>
                </Inline>
              }
            />
          </Form>
          <AppliedFilterChips
            filters={appliedFilters}
            clearAction={
              appliedFilters.length > 0 ? (
                <LinkButton href="/account/listings" size="sm" tone="secondary">
                  {t("marketplace.features.listings.ui.listingListPage.clear.filters")}
                </LinkButton>
              ) : null
            }
          />

          {bulkActionOutcomes && bulkActionOutcomes.length > 0 ? (
            <Card>
              <Stack gap={2}>
                <Text weight="semibold">
                  {t("marketplace.features.listings.ui.listingListPage.bulk.action.results", {
                    succeeded: succeededOutcomeCount,
                    failed: failedOutcomeCount,
                  })}
                </Text>
                {bulkActionOutcomes.map((outcome) => (
                  <Inline key={outcome.listingId} align="center">
                    <Badge tone={outcome.outcome === "success" ? "success" : "danger"}>
                      {outcome.outcome === "success"
                        ? t("marketplace.features.listings.ui.listingListPage.bulk.action.succeeded")
                        : t("marketplace.features.listings.ui.listingListPage.bulk.action.failed")}
                    </Badge>
                    <Text size="sm">{outcome.label}</Text>
                    {outcome.message ? (
                      <Text size="sm" tone="secondary">
                        {outcome.message}
                      </Text>
                    ) : null}
                  </Inline>
                ))}
              </Stack>
            </Card>
          ) : null}

          <Form spacing="none" method="post">
            {[...selectedListingIds].map((listingId) => (
              <HiddenInput key={listingId} type="hidden" name="listingIds" value={listingId} />
            ))}
            <Stack gap={3}>
              <DataTable
                rows={[...data.items]}
                getRowId={(row) => row.listing_id}
                selectedKeys={selectedListingIds}
                onSelectionChange={setSelectedListingIds}
                columns={[
                  {
                    key: "listing",
                    header: t("marketplace.features.listings.ui.listingListPage.listing"),
                    cell: (row) => (
                      <Stack gap={1}>
                        <Text weight="semibold">{row.item_title ?? row.catalog_catalog_item_id}</Text>
                        {row.item_language_code ? (
                          <Badge tone="neutral">{formatLanguageCodeLabel(row.item_language_code)}</Badge>
                        ) : null}
                        {row.item_subtitle ? (
                          <Text tone="secondary" size="sm">
                            {row.item_subtitle}
                          </Text>
                        ) : null}
                        {row.product_summary ? (
                          <ProductOptions options={productOptionsFromSummary(row.product_summary)} variant="chips" />
                        ) : null}
                        {row.product_measure_snapshot ? null : (
                          <Badge tone="warning">
                            {t("marketplace.features.listings.ui.listingListPage.shipping.measure.missing")}
                          </Badge>
                        )}
                        {row.evidence.length > 0 ? (
                          <Text tone="secondary" size="sm">
                            {t("marketplace.features.listings.ui.listingListPage.photo.count", {
                              count: row.evidence.length,
                            })}
                          </Text>
                        ) : null}
                      </Stack>
                    ),
                  },
                  {
                    key: "price",
                    header: t("marketplace.features.listings.ui.listingListPage.price.2"),
                    cell: (row) => (
                      <Stack gap={1}>
                        <Text weight="semibold">{formatMoney(row.price_amount)}</Text>
                        <Text size="sm" tone="secondary">
                          {renderFeeSummary(row)}
                        </Text>
                      </Stack>
                    ),
                  },
                  {
                    key: "quantityCap",
                    header: t("marketplace.features.listings.ui.listingListPage.cap"),
                    align: "right",
                    cell: (row) => row.quantity_cap,
                  },
                  {
                    key: "status",
                    header: t("marketplace.features.listings.ui.listingListPage.status"),
                    cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
                  },
                  {
                    key: "location",
                    header: t("marketplace.features.listings.ui.listingListPage.inventory"),
                    cell: (row) => (
                      <Stack gap={1}>
                        <Text>
                          {row.storage_location_name ??
                            t("marketplace.features.listings.ui.listingListPage.location.unavailable")}
                        </Text>
                        {row.terms_resolved_at ? (
                          <Text size="sm" tone="secondary">
                            {t("marketplace.features.listings.ui.listingListPage.terms.resolved")}
                            {formatTimestamp(row.terms_resolved_at)}
                          </Text>
                        ) : null}
                      </Stack>
                    ),
                  },
                  {
                    key: "actions",
                    header: t("marketplace.features.listings.ui.listingListPage.actions"),
                    cell: (row) => (
                      <LinkButton href={`/account/listings/${row.listing_id}`} tone="secondary" size="sm">
                        {t("marketplace.features.listings.ui.listingListPage.open")}
                      </LinkButton>
                    ),
                  },
                ]}
                emptyTitle={t("marketplace.features.listings.ui.listingListPage.no.listings.yet")}
                emptyDescription={t(
                  "marketplace.features.listings.ui.listingListPage.create.a.listing.from.available.inventory",
                )}
              />
              {showPagination ? (
                <Pagination
                  page={currentPage}
                  totalPages={totalPages}
                  onPageChange={(page) => navigateToListingListPage(page, pageSize)}
                />
              ) : null}
              {selectedListingIds.size > 0 ? (
                <BulkActionBar
                  count={selectedListingIds.size}
                  formatSelectedLabel={(count) =>
                    t("marketplace.features.listings.ui.listingListPage.bulk.selected", { count })
                  }
                  primaryActions={
                    <Inline gap={2} align="end">
                      <Button type="submit" name="intent" value="bulk-pause-listings" size="sm">
                        {t("marketplace.features.listings.ui.listingListPage.pause.selected")}
                      </Button>
                      <Button type="submit" name="intent" value="bulk-withdraw-listings" tone="secondary" size="sm">
                        {t("marketplace.features.listings.ui.listingListPage.withdraw.selected")}
                      </Button>
                    </Inline>
                  }
                  secondaryActions={
                    <Button type="button" tone="secondary" size="sm" onClick={() => setSelectedListingIds(new Set())}>
                      {t("marketplace.features.listings.ui.listingListPage.clear.selection")}
                    </Button>
                  }
                />
              ) : null}
            </Stack>
          </Form>
        </Stack>
      </PageSection>

      <PageSection title={t("marketplace.features.listings.ui.listingListPage.fee.lock.report")}>
        <ProgressiveDisclosure
          title={t("marketplace.features.listings.ui.listingListPage.fee.lock.report")}
          summary={t("marketplace.features.listings.ui.listingListPage.fee.lock.records.summary", {
            count: feeLockReport?.items.length ?? 0,
          })}
          tone={(feeLockReport?.items.length ?? 0) > 0 ? "info" : "neutral"}
        >
          <DataTable
            rows={[...(feeLockReport?.items ?? [])]}
            getRowId={(row) => row.listing_id}
            columns={[
              {
                key: "listing",
                header: t("marketplace.features.listings.ui.listingListPage.listing"),
                cell: (row) => (
                  <Stack gap={1}>
                    <Text weight="semibold">{row.item_title ?? row.inventory_item_id}</Text>
                    {row.product_summary ? (
                      <ProductOptions options={productOptionsFromSummary(row.product_summary)} variant="chips" />
                    ) : null}
                  </Stack>
                ),
              },
              {
                key: "fee",
                header: t("marketplace.features.listings.ui.listingListPage.locked.fee"),
                cell: (row) => (
                  <Stack gap={1}>
                    <Text>{formatMoney(row.marketplace_sales_fee_unit_amount)}</Text>
                    <Text size="sm" tone="secondary">
                      {t("marketplace.features.listings.ui.listingListPage.seller.net.report", {
                        amount: formatMoney(row.seller_net_unit_amount),
                      })}
                    </Text>
                  </Stack>
                ),
              },
              {
                key: "source",
                header: t("marketplace.features.listings.ui.listingListPage.terms.source"),
                cell: (row) => (
                  <Stack gap={1}>
                    <Text>{termsSource(row)}</Text>
                    <Text size="sm" tone="secondary">
                      {formatTimestamp(row.terms_resolved_at)}
                    </Text>
                  </Stack>
                ),
              },
              {
                key: "status",
                header: t("marketplace.features.listings.ui.listingListPage.status"),
                cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
              },
              {
                key: "quantityCap",
                header: t("marketplace.features.listings.ui.listingListPage.cap"),
                align: "right",
                cell: (row) => row.quantity_cap,
              },
              {
                key: "updated",
                header: t("marketplace.features.listings.ui.listingListPage.updated"),
                cell: (row) => formatTimestamp(row.updated_at),
              },
            ]}
            emptyTitle={t("marketplace.features.listings.ui.listingListPage.no.fee.locks")}
            emptyDescription={t("marketplace.features.listings.ui.listingListPage.fee.lock.report.empty")}
          />
        </ProgressiveDisclosure>
      </PageSection>
    </Page>
  );
}
