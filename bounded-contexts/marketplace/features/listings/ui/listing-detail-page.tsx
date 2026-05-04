import { t } from "@chase-sets/localization";
import {
  Badge,
  Banner,
  Button,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
  NumberInput,
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
  ].join(" | ");
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
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("marketplace.features.listings.ui.listingDetailPage.listing.overview")}>
        <Card>
          <Stack gap={2}>
            <Banner
              title={t("marketplace.features.listings.ui.listingDetailPage.buyer.shipping.credit")}
              description={t("marketplace.features.listings.ui.listingDetailPage.buyers.earn.percentage.toward.shipping.when.grouping", {
                percentage: formatAllowancePercentage(listing.shipping_allowance_percentage_bps),
              })}
            />
            {listing.item_subtitle ? (
              <Text tone="secondary">{listing.item_subtitle}</Text>
            ) : null}
            {listing.product_summary ? (
              <Text size="sm" tone="secondary">
                {listing.product_summary}
              </Text>
            ) : null}
            <Badge tone={statusTone(listing.status)}>{listing.status}</Badge>
            <Text>{t("marketplace.features.listings.ui.listingDetailPage.price")}{formatMoney(listing.price_amount)}</Text>
            <Text>{t("marketplace.features.listings.ui.listingDetailPage.marketplace.fee")}{formatOptionalMoney(listing.marketplace_sales_fee_unit_amount)}</Text>
            <Text>{t("marketplace.features.listings.ui.listingDetailPage.seller.net")}{formatOptionalMoney(listing.seller_net_unit_amount)}</Text>
            <Text>
              {t("marketplace.features.listings.ui.listingDetailPage.buyer.shipping.credit.rate")}
              {formatAllowancePercentage(listing.shipping_allowance_percentage_bps)}
            </Text>
            <Text>
              {t("marketplace.features.listings.ui.listingDetailPage.terms.schedule")}{listing.terms_schedule_id ?? t("marketplace.features.listings.ui.listingDetailPage.default.fallback.unavailable")}
            </Text>
            <Text>{t("marketplace.features.listings.ui.listingDetailPage.agreement.override")}{listing.terms_agreement_id ?? t("marketplace.features.listings.ui.listingDetailPage.none")}</Text>
            <Text>
              {t("marketplace.features.listings.ui.listingDetailPage.terms.resolved.at")}{" "}
              {listing.terms_resolved_at
                ? new Date(listing.terms_resolved_at).toLocaleString()
                : t("marketplace.features.listings.ui.listingDetailPage.not.set.2")}
            </Text>
            <Text>{t("marketplace.features.listings.ui.listingDetailPage.quantity.cap")}{listing.quantity_cap}</Text>
            <Text>
              {t("marketplace.features.listings.ui.listingDetailPage.inventory")}{listing.storage_location_name ?? t("marketplace.features.listings.ui.listingDetailPage.unknown.location")}{" "}
              {listing.ship_from_code
                ? t("marketplace.features.listings.ui.listingDetailPage.ship.from.code", {
                    shipFromCode: listing.ship_from_code,
                  })
                : ""}
            </Text>
          </Stack>
        </Card>
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
                    {t("marketplace.features.listings.ui.listingDetailPage.terms.schedule")}{entry.terms_schedule_id ?? t("marketplace.features.listings.ui.listingDetailPage.default.fallback.unavailable")}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.agreement.override")}{entry.terms_agreement_id ?? t("marketplace.features.listings.ui.listingDetailPage.none")}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.terms.resolved.at")} {formatTimestamp(entry.terms_resolved_at)}
                  </Text>
                  {entry.performed_by_user_id ? (
                    <Text size="sm" tone="secondary">
                      {t("marketplace.features.listings.ui.listingDetailPage.fee.history.changed.by", {
                        userId: entry.performed_by_user_id,
                      })}
                    </Text>
                  ) : null}
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

      <PageSection title={t("marketplace.features.listings.ui.listingDetailPage.update.listing")}>
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
                  {t("marketplace.features.listings.ui.listingDetailPage.terms.schedule.2")}{pricePreview.schedule_id ?? t("marketplace.features.listings.ui.listingDetailPage.no.schedule.available")}
                </Text>
                <Text size="sm" tone="secondary">
                  {t("marketplace.features.listings.ui.listingDetailPage.agreement.override.2")}{pricePreview.agreement_id ?? t("marketplace.features.listings.ui.listingDetailPage.none.2")}
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
