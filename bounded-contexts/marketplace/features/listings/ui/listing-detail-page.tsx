import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  BuyerProtectionModule,
  Card,
  Inline,
  KeyValueList,
  LinkButton,
  MarketplaceNotice,
  MarketplaceStatusTimeline,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  SpecificationList,
  Stack,
  Text,
  TextInput,
  NumberInput,
  ProductSelectionSummary,
  productSelectionDetailsFromSummary,
} from "@chase-sets/design-system";
import type {
  MarketplaceListingDetail,
  MarketplaceListingFeeHistoryEntry,
  MarketplaceListingTermsPreview,
} from "./contracts";

function formatMoney(amount: string) {
  return `$${amount}`;
}

function formatOptionalMoney(amount: string | null) {
  return amount ? formatMoney(amount) : t("marketplace.features.listings.ui.listingDetailPage.not.set");
}

function formatAllowancePercentage(bps: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(bps / 100)}%`;
}

function renderPreviewSummary(preview: MarketplaceListingTermsPreview) {
  return [
    t("marketplace.features.listings.ui.listingDetailPage.marketplace.fee.summary", {
      amount: formatMoney(preview.marketplace_sales_fee_unit_amount),
    }),
    t("marketplace.features.listings.ui.listingDetailPage.net.summary", {
      amount: formatMoney(preview.seller_net_unit_amount),
    }),
    t("marketplace.features.listings.ui.listingDetailPage.buyer.shipping.credit.summary", {
      percentage: formatAllowancePercentage(preview.shipping_allowance_percentage_bps),
    }),
  ].join(". ");
}

function formatTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : t("marketplace.features.listings.ui.listingDetailPage.not.set");
}

function feeHistoryLabel(eventType: string) {
  switch (eventType) {
    case "marketplace.listing.created":
      return t("marketplace.features.listings.ui.listingDetailPage.fee.history.created");
    case "marketplace.listing.published":
      return t("marketplace.features.listings.ui.listingDetailPage.fee.history.published");
    case "marketplace.listing.price-updated":
      return t("marketplace.features.listings.ui.listingDetailPage.fee.history.price.updated");
    case "marketplace.listing.quantity-cap-updated":
      return t("marketplace.features.listings.ui.listingDetailPage.fee.history.quantity.updated");
    default:
      return eventType;
  }
}

function termsLabel(terms: Pick<MarketplaceListingTermsPreview, "agreement_id" | "schedule_id">) {
  if (terms.agreement_id) {
    return "Seller terms";
  }

  if (terms.schedule_id) {
    return "Standard seller terms";
  }

  return t("marketplace.features.listings.ui.listingDetailPage.default.fallback.unavailable");
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

function ProductSummaryChips({ summary }: { summary: string }) {
  return (
    <ProductSelectionSummary
      selections={productSelectionDetailsFromSummary(summary)}
      summary={summary}
      summaryAsChip
    />
  );
}

export function MarketplaceListingDetailPage({
  listing,
  feeHistory,
  priceDraftAmount,
  pricePreview,
  errorMessage,
}: {
  listing: MarketplaceListingDetail;
  feeHistory?: readonly MarketplaceListingFeeHistoryEntry[];
  priceDraftAmount?: string | null;
  pricePreview?: MarketplaceListingTermsPreview | null;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.listings.ui.listingDetailPage.seller")}
        title={listing.item_title ?? listing.catalog_catalog_item_id}
        description={t("marketplace.features.listings.ui.listingDetailPage.manage.seller.listing.pricing.quantity.caps")}
        actions={
          <LinkButton href="/account/listings" tone="secondary">
            {t("marketplace.features.listings.ui.listingDetailPage.back.to.listings")}</LinkButton>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice tone="error" title={t("marketplace.features.listings.ui.listingDetailPage.update.listing")} description={errorMessage} />
      ) : null}

      <PageSection title={t("marketplace.features.listings.ui.listingDetailPage.listing.overview")}>
        <Stack gap={4}>
          <Card>
            <Stack gap={4}>
              <Stack gap={2}>
                <Inline>
                  <Badge tone={statusTone(listing.status)}>{listing.status}</Badge>
                  {listing.status === "active" ? (
                    <Badge tone="success">
                      {t("marketplace.features.listings.ui.listingDetailPage.verified.seller")}
                    </Badge>
                  ) : null}
                </Inline>
                <Text size="lg" weight="semibold">
                  {listing.item_title ?? listing.catalog_catalog_item_id}
                </Text>
                {listing.item_subtitle ? (
                  <Text tone="secondary">{listing.item_subtitle}</Text>
                ) : null}
                {listing.product_summary ? (
                  <ProductSummaryChips summary={listing.product_summary} />
                ) : null}
                <Text size="lg" weight="semibold">{formatMoney(listing.price_amount)}</Text>
                <Text size="sm" tone="secondary">
                  {renderPreviewSummary({
                    account_type: "personal",
                    basis_amount: listing.price_amount,
                    fee_quote_fingerprint: listing.fee_quote_fingerprint,
                    marketplace_sales_fee_unit_amount: listing.marketplace_sales_fee_unit_amount ?? "0.00",
                    seller_net_unit_amount: listing.seller_net_unit_amount ?? "0.00",
                    shipping_allowance_percentage_bps: listing.shipping_allowance_percentage_bps,
                    schedule_id: listing.terms_schedule_id,
                    agreement_id: listing.terms_agreement_id,
                    resolved_at: listing.terms_resolved_at ?? new Date().toISOString(),
                  })}
                </Text>
              </Stack>
              <KeyValueList
                density="compact"
                variant="plain"
                items={[
                  {
                    key: t("marketplace.features.listings.ui.listingDetailPage.inventory"),
                    value: `${listing.storage_location_name ?? t("marketplace.features.listings.ui.listingDetailPage.unknown.location")} ${listing.ship_from_code ?? ""}`.trim(),
                  },
                  {
                    key: t("marketplace.features.listings.ui.listingDetailPage.quantity.cap"),
                    value: listing.quantity_cap,
                  },
                  {
                    key: t("marketplace.features.listings.ui.listingDetailPage.buyer.shipping.credit.rate"),
                    value: formatAllowancePercentage(listing.shipping_allowance_percentage_bps),
                  },
                ]}
              />
              <LinkButton href="#update-listing" size="sm">
                {t("marketplace.features.listings.ui.listingDetailPage.update.listing")}
              </LinkButton>
            </Stack>
          </Card>

          <PriceBreakdown
            lines={[
              {
                label: t("marketplace.features.listings.ui.listingDetailPage.price"),
                value: formatMoney(listing.price_amount),
              },
              {
                label: t("marketplace.features.listings.ui.listingDetailPage.marketplace.fee"),
                value: formatOptionalMoney(listing.marketplace_sales_fee_unit_amount),
              },
              {
                label: t("marketplace.features.listings.ui.listingDetailPage.buyer.shipping.credit.rate"),
                value: formatAllowancePercentage(listing.shipping_allowance_percentage_bps),
              },
              {
                label: t("marketplace.features.listings.ui.listingDetailPage.quantity.cap"),
                value: listing.quantity_cap,
              },
            ]}
            total={formatOptionalMoney(listing.seller_net_unit_amount)}
            totalLabel={t("marketplace.features.listings.ui.listingDetailPage.seller.net")}
          />

          <BuyerProtectionModule
            title={t("marketplace.features.listings.ui.listingDetailPage.buyer.shipping.credit")}
            items={[
              {
                title: t("marketplace.features.listings.ui.listingDetailPage.buyer.shipping.credit"),
                description: t("marketplace.features.listings.ui.listingDetailPage.buyers.earn.percentage.toward.shipping.when.grouping", {
                  percentage: formatAllowancePercentage(listing.shipping_allowance_percentage_bps),
                }),
              },
              {
                title: t("marketplace.features.listings.ui.listingDetailPage.inventory"),
                description: listing.storage_location_name ?? t("marketplace.features.listings.ui.listingDetailPage.unknown.location"),
              },
              {
                title: t("marketplace.features.listings.ui.listingDetailPage.terms.resolved.at"),
                description: listing.terms_resolved_at
                  ? new Date(listing.terms_resolved_at).toLocaleString()
                  : t("marketplace.features.listings.ui.listingDetailPage.not.set.2"),
              },
            ]}
          />

          <SpecificationList
            title={t("marketplace.features.listings.ui.listingDetailPage.listing.overview")}
            specs={[
              {
                label: t("marketplace.features.listings.ui.listingDetailPage.terms.schedule"),
                value: termsLabel({
                  agreement_id: listing.terms_agreement_id,
                  schedule_id: listing.terms_schedule_id,
                }),
              },
              {
                label: t("marketplace.features.listings.ui.listingDetailPage.agreement.override"),
                value: listing.terms_agreement_id
                  ? t("marketplace.features.listings.ui.listingDetailPage.seller.terms.override")
                  : t("marketplace.features.listings.ui.listingDetailPage.none"),
              },
              {
                label: t("marketplace.features.listings.ui.listingDetailPage.inventory"),
                value: `${listing.storage_location_name ?? t("marketplace.features.listings.ui.listingDetailPage.unknown.location")} ${listing.ship_from_code ?? ""}`.trim(),
              },
            ]}
          />

          <MarketplaceStatusTimeline
            steps={[
              {
                label: listing.status,
                description: t("marketplace.features.listings.ui.listingDetailPage.manage.seller.listing.pricing.quantity.caps"),
                status: listing.status === "active" ? "complete" : "current",
              },
              {
                label: t("marketplace.features.listings.ui.listingDetailPage.fee.lock.history"),
                description: t("marketplace.features.listings.ui.listingDetailPage.terms.resolved.at") + " " + formatTimestamp(listing.terms_resolved_at),
                status: listing.terms_resolved_at ? "complete" : "upcoming",
              },
            ]}
          />
        </Stack>
      </PageSection>

      <PageSection title={t("marketplace.features.listings.ui.listingDetailPage.fee.lock.history")}>
        <Card>
          <Stack gap={3}>
            {(feeHistory ?? []).length > 0 ? (
              feeHistory!.map((entry) => (
                <Stack key={`${entry.event_type}:${entry.stream_version}`} gap={1}>
                  <Text weight="semibold">{feeHistoryLabel(entry.event_type)}</Text>
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.fee.history.recorded", {
                      version: entry.stream_version,
                      recordedAt: formatTimestamp(entry.recorded_at),
                    })}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.price")}{entry.price_amount ? formatMoney(entry.price_amount) : formatMoney(listing.price_amount)}
                  </Text>
                  {entry.quantity_cap !== null ? (
                    <Text size="sm" tone="secondary">
                      {t("marketplace.features.listings.ui.listingDetailPage.quantity.cap")}{entry.quantity_cap}
                    </Text>
                  ) : null}
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.marketplace.fee")}{formatOptionalMoney(entry.marketplace_sales_fee_unit_amount)}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.seller.net")}{formatOptionalMoney(entry.seller_net_unit_amount)}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.terms.schedule")}{termsLabel({
                      agreement_id: entry.terms_agreement_id,
                      schedule_id: entry.terms_schedule_id,
                    })}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.terms.resolved.at")} {formatTimestamp(entry.terms_resolved_at)}
                  </Text>
                </Stack>
              ))
            ) : (
              <Text tone="secondary">
                {t("marketplace.features.listings.ui.listingDetailPage.no.fee.history")}
              </Text>
            )}
          </Stack>
        </Card>
      </PageSection>

      <PageSection id="update-listing" title={t("marketplace.features.listings.ui.listingDetailPage.update.listing")}>
        <Stack gap={4}>
          <Card>
            <form method="post">
              <Stack gap={3}>
                <TextInput
                  label={t("marketplace.features.listings.ui.listingDetailPage.price.2")}
                  name="priceAmount"
                  defaultValue={priceDraftAmount ?? listing.price_amount}
                  inputMode="decimal"
                  required
                />
                <input
                  type="hidden"
                  name="feeQuoteFingerprint"
                  value={pricePreview?.fee_quote_fingerprint ?? listing.fee_quote_fingerprint}
                />
                <Stack gap={2}>
                  <Button type="submit" name="intent" value="update-price" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.save.price")}</Button>
                  <Button type="submit" name="intent" value="preview-price" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.preview.fees")}</Button>
                </Stack>
              </Stack>
            </form>
            {pricePreview ? (
              <Stack gap={2}>
                <Text weight="semibold">{t("marketplace.features.listings.ui.listingDetailPage.updated.fee.preview")}</Text>
                <Text size="sm" tone="secondary">
                  {t("marketplace.features.listings.ui.listingDetailPage.account.type")}{pricePreview.account_type}
                </Text>
                <Text size="sm" tone="secondary">
                  {renderPreviewSummary(pricePreview)}
                </Text>
                <Text size="sm" tone="secondary">
                  {t("marketplace.features.listings.ui.listingDetailPage.basis.amount")}{formatMoney(pricePreview.basis_amount)}
                </Text>
                <Text size="sm" tone="secondary">
                  {t("marketplace.features.listings.ui.listingDetailPage.terms.schedule.2")}{termsLabel(pricePreview)}
                </Text>
              </Stack>
            ) : null}
          </Card>

          <Card>
            <form method="post">
              <Stack gap={3}>
                <input type="hidden" name="intent" value="update-quantity-cap" />
                <input
                  type="hidden"
                  name="feeQuoteFingerprint"
                  value={listing.fee_quote_fingerprint}
                />
                <NumberInput
                  label={t("marketplace.features.listings.ui.listingDetailPage.quantity.cap.2")}
                  name="quantityCap"
                  defaultValue={String(listing.quantity_cap)}
                  min="1"
                  required
                />
                <Button type="submit" tone="secondary">
                  {t("marketplace.features.listings.ui.listingDetailPage.save.quantity.cap")}</Button>
              </Stack>
            </form>
          </Card>

          <Card>
            <Stack gap={3}>
              <form method="post">
                <input type="hidden" name="intent" value="publish" />
                <input
                  type="hidden"
                  name="feeQuoteFingerprint"
                  value={listing.fee_quote_fingerprint}
                />
                <Button type="submit" disabled={listing.status === "active" || listing.status === "withdrawn"}>
                  {t("marketplace.features.listings.ui.listingDetailPage.publish.listing")}</Button>
              </form>
              <form method="post">
                <input type="hidden" name="intent" value="pause" />
                <Button type="submit" tone="secondary" disabled={listing.status !== "active"}>
                  {t("marketplace.features.listings.ui.listingDetailPage.pause.listing")}</Button>
              </form>
              <form method="post">
                <input type="hidden" name="intent" value="withdraw" />
                <Button type="submit" tone="danger" disabled={listing.status === "withdrawn"}>
                  {t("marketplace.features.listings.ui.listingDetailPage.withdraw.listing")}</Button>
              </form>
            </Stack>
          </Card>
        </Stack>
      </PageSection>
    </Page>
  );
}
