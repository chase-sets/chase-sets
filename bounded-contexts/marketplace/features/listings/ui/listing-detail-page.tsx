import { formatBpsPercent, formatDateTime, formatLanguageCodeLabel, formatMoney, t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  HiddenInput,
  Form,
  Badge,
  Button,
  FileDropzone,
  ImageGallery,
  OrderProtectionModule,
  Card,
  Inline,
  KeyValueList,
  LinkButton,
  MarketplaceNotice,
  MarketplaceStatusTimeline,
  ModalDialog,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProgressiveDisclosure,
  SpecificationList,
  Stack,
  Text,
  TextInput,
  NumberField,
  ProductOptions,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type {
  MarketplaceListingDetail,
  MarketplaceListingFeeHistoryEntry,
  MarketplaceListingTermsPreview,
} from "./contracts";

function listingPhotoImage(
  photo: MarketplaceListingDetail["evidence"][number],
  role: "thumbnail" | "search-card" | "catalog-detail",
  sizes: string,
) {
  const variants = photo.assetSet.variants
    .filter((variant) => variant.role === role)
    .sort((left, right) => left.width - right.width);
  const oneX = variants.find((variant) => variant.density === 1) ?? variants[0] ?? null;

  if (!oneX) {
    return {
      src: photo.assetSet.source.publicUrl,
      srcSet: undefined,
      sizes,
      width: photo.assetSet.source.width,
      height: photo.assetSet.source.height,
    };
  }

  return {
    src: oneX.publicUrl,
    srcSet: variants.map((variant) => `${variant.publicUrl} ${variant.width}w`).join(", "),
    sizes,
    width: oneX.width,
    height: oneX.height,
  };
}

function listingPhotoImages(listing: MarketplaceListingDetail) {
  return listing.evidence.map((photo, index) => {
    const detailImage = listingPhotoImage(photo, "catalog-detail", "(min-width: 768px) 480px, min(100vw, 276px)");
    const thumbnailImage = listingPhotoImage(photo, "thumbnail", "64px");

    return {
      ...detailImage,
      thumbnailSrc: thumbnailImage.src,
      thumbnailSrcSet: thumbnailImage.srcSet,
      thumbnailSizes: thumbnailImage.sizes,
      alt: photo.altText ?? `${listing.item_title ?? listing.catalog_catalog_item_id} photo ${index + 1}`,
      label: photo.originalFilename ?? `Photo ${index + 1}`,
    };
  });
}

function formatOptionalMoney(amount: string | null) {
  return amount ? formatMoney(amount, "USD") : t("marketplace.features.listings.ui.listingDetailPage.not.set");
}

function renderPreviewSummary(preview: MarketplaceListingTermsPreview) {
  return [
    t("marketplace.features.listings.ui.listingDetailPage.marketplace.fee.summary", {
      amount: formatMoney(preview.marketplace_sales_fee_unit_amount, "USD"),
    }),
    t("marketplace.features.listings.ui.listingDetailPage.net.summary", {
      amount: formatMoney(preview.seller_net_unit_amount, "USD"),
    }),
    t("marketplace.features.listings.ui.listingDetailPage.buyer.shipping.credit.summary", {
      percentage: formatBpsPercent(preview.shipping_allowance_percentage_bps),
    }),
  ].join(". ");
}

function formatTimestamp(value: string | null) {
  return value ? formatDateTime(value) : t("marketplace.features.listings.ui.listingDetailPage.not.set");
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

function listingPurchaseLimitSummary(listing: MarketplaceListingDetail) {
  const limits = [
    listing.max_units_per_order == null
      ? null
      : t("marketplace.features.listings.ui.listingDetailPage.purchase.limit.order.summary", {
          limit: listing.max_units_per_order,
        }),
    listing.max_units_per_day == null
      ? null
      : t("marketplace.features.listings.ui.listingDetailPage.purchase.limit.day.summary", {
          limit: listing.max_units_per_day,
        }),
    listing.max_units_per_customer_account == null
      ? null
      : t("marketplace.features.listings.ui.listingDetailPage.purchase.limit.customer.summary", {
          limit: listing.max_units_per_customer_account,
        }),
  ].filter(Boolean);

  return limits.length > 0
    ? t("marketplace.features.listings.ui.listingDetailPage.active.purchase.limits", { limits: limits.join(", ") })
    : t("marketplace.features.listings.ui.listingDetailPage.no.seller.purchase.limits");
}

export function MarketplaceListingDetailPage({
  listing,
  feeHistory,
  priceDraftAmount,
  pricePreview,
  errorMessage,
  feedbackPrompt,
}: {
  listing: MarketplaceListingDetail;
  feeHistory?: readonly MarketplaceListingFeeHistoryEntry[];
  priceDraftAmount?: string | null;
  pricePreview?: MarketplaceListingTermsPreview | null;
  errorMessage?: string | null;
  feedbackPrompt?: ReactNode;
}) {
  const currentFeeLock = listing.fee_locks.at(-1);
  const publishDisabled =
    listing.status === "active" || listing.status === "withdrawn" || listing.product_measure_snapshot === null;

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.listings.ui.listingDetailPage.seller")}
        title={listing.item_title ?? listing.catalog_catalog_item_id}
        description={t(
          "marketplace.features.listings.ui.listingDetailPage.manage.seller.listing.pricing.quantity.caps",
        )}
        actions={
          <LinkButton href="/account/listings" tone="secondary">
            {t("marketplace.features.listings.ui.listingDetailPage.back.to.listings")}
          </LinkButton>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
          title={t("marketplace.features.listings.ui.listingDetailPage.update.listing")}
          description={errorMessage}
        />
      ) : null}

      {feedbackPrompt}

      <PageSection title={t("marketplace.features.listings.ui.listingDetailPage.listing.overview")}>
        <Stack gap={4}>
          <Card>
            <Stack gap={4}>
              {listing.evidence.length > 0 ? (
                <ImageGallery images={listingPhotoImages(listing)} aspectRatio="3/4" />
              ) : null}
              <Stack gap={2}>
                <Inline>
                  <Badge tone={statusTone(listing.status)}>{listing.status}</Badge>
                  {listing.item_language_code ? (
                    <Badge tone="neutral">{formatLanguageCodeLabel(listing.item_language_code)}</Badge>
                  ) : null}
                  {listing.status === "active" ? (
                    <Badge tone="success">
                      {t("marketplace.features.listings.ui.listingDetailPage.verified.seller")}
                    </Badge>
                  ) : null}
                  {listing.product_measure_snapshot ? null : (
                    <Badge tone="warning">
                      {t("marketplace.features.listings.ui.listingDetailPage.shipping.measure.missing")}
                    </Badge>
                  )}
                </Inline>
                {listing.product_measure_snapshot ? null : (
                  <MarketplaceNotice
                    tone="warning"
                    title={t("marketplace.features.listings.ui.listingDetailPage.shipping.measure.missing")}
                    description={t(
                      "marketplace.features.listings.ui.listingDetailPage.shipping.measure.missing.description",
                    )}
                  />
                )}
                <Text size="lg" weight="semibold">
                  {listing.item_title ?? listing.catalog_catalog_item_id}
                </Text>
                {listing.item_subtitle ? <Text tone="secondary">{listing.item_subtitle}</Text> : null}
                {listing.product_summary ? (
                  <ProductOptions options={productOptionsFromSummary(listing.product_summary)} variant="chips" />
                ) : null}
                <Text size="lg" weight="semibold">
                  {formatMoney(listing.price_amount, "USD")}
                </Text>
                <Text size="sm" tone="secondary">
                  {renderPreviewSummary({
                    account_type: "personal",
                    basis_amount: listing.price_amount,
                    fee_quote_fingerprint: listing.fee_quote_fingerprint,
                    marketplace_sales_fee_unit_amount: listing.marketplace_sales_fee_unit_amount ?? "0.00",
                    seller_net_unit_amount: listing.seller_net_unit_amount ?? "0.00",
                    marketplace_sales_fee_percentage_bps: currentFeeLock?.terms.marketplaceSalesFeePercentageBps ?? 0,
                    marketplace_sales_fee_fixed_amount: currentFeeLock?.terms.marketplaceSalesFeeFixedAmount ?? "0.00",
                    marketplace_sales_fee_cap_amount: currentFeeLock?.terms.marketplaceSalesFeeCapAmount ?? null,
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
                    value:
                      `${listing.storage_location_name ?? t("marketplace.features.listings.ui.listingDetailPage.unknown.location")} ${listing.ship_from_code ?? ""}`.trim(),
                  },
                  {
                    key: t("marketplace.features.listings.ui.listingDetailPage.quantity.cap"),
                    value: listing.quantity_cap,
                  },
                  {
                    key: t("marketplace.features.listings.ui.listingDetailPage.buyer.shipping.credit.rate"),
                    value: formatBpsPercent(listing.shipping_allowance_percentage_bps),
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
                value: formatMoney(listing.price_amount, "USD"),
              },
              {
                label: t("marketplace.features.listings.ui.listingDetailPage.marketplace.fee"),
                value: formatOptionalMoney(listing.marketplace_sales_fee_unit_amount),
              },
              {
                label: t("marketplace.features.listings.ui.listingDetailPage.buyer.shipping.credit.rate"),
                value: formatBpsPercent(listing.shipping_allowance_percentage_bps),
              },
              {
                label: t("marketplace.features.listings.ui.listingDetailPage.quantity.cap"),
                value: listing.quantity_cap,
              },
            ]}
            total={formatOptionalMoney(listing.seller_net_unit_amount)}
            totalLabel={t("marketplace.features.listings.ui.listingDetailPage.seller.net")}
          />

          <OrderProtectionModule
            title={t("marketplace.features.listings.ui.listingDetailPage.buyer.shipping.credit")}
            items={[
              {
                title: t("marketplace.features.listings.ui.listingDetailPage.buyer.shipping.credit"),
                description: t(
                  "marketplace.features.listings.ui.listingDetailPage.buyers.earn.percentage.toward.shipping.when.grouping",
                  {
                    percentage: formatBpsPercent(listing.shipping_allowance_percentage_bps),
                  },
                ),
              },
              {
                title: t("marketplace.features.listings.ui.listingDetailPage.inventory"),
                description:
                  listing.storage_location_name ??
                  t("marketplace.features.listings.ui.listingDetailPage.unknown.location"),
              },
              {
                title: t("marketplace.features.listings.ui.listingDetailPage.terms.resolved.at"),
                description: formatTimestamp(listing.terms_resolved_at),
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
                value:
                  `${listing.storage_location_name ?? t("marketplace.features.listings.ui.listingDetailPage.unknown.location")} ${listing.ship_from_code ?? ""}`.trim(),
              },
            ]}
          />

          <MarketplaceStatusTimeline
            steps={[
              {
                label: listing.status,
                description: t(
                  "marketplace.features.listings.ui.listingDetailPage.manage.seller.listing.pricing.quantity.caps",
                ),
                status: listing.status === "active" ? "complete" : "current",
              },
              {
                label: t("marketplace.features.listings.ui.listingDetailPage.fee.lock.history"),
                description:
                  t("marketplace.features.listings.ui.listingDetailPage.terms.resolved.at") +
                  " " +
                  formatTimestamp(listing.terms_resolved_at),
                status: listing.terms_resolved_at ? "complete" : "upcoming",
              },
            ]}
          />
        </Stack>
      </PageSection>

      <PageSection title={t("marketplace.features.listings.ui.listingDetailPage.fee.lock.history")}>
        <ProgressiveDisclosure
          title={t("marketplace.features.listings.ui.listingDetailPage.fee.lock.history")}
          summary={t("marketplace.features.listings.ui.listingDetailPage.fee.history.summary", {
            count: feeHistory?.length ?? 0,
          })}
          tone={(feeHistory?.length ?? 0) > 0 ? "info" : "neutral"}
        >
          <Card>
            <Form spacing="none" method="post" encType="multipart/form-data">
              <Stack gap={3}>
                <HiddenInput type="hidden" name="intent" value="add-photos" />
                <FileDropzone
                  label={t("marketplace.features.listings.ui.listingDetailPage.listing.photos")}
                  description={t("marketplace.features.listings.ui.listingDetailPage.listing.photos.description")}
                  name="evidence"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  dropLabel={t("marketplace.features.listings.ui.listingDetailPage.drop.listing.photos")}
                  browseLabel={t("marketplace.features.listings.ui.listingDetailPage.choose.photos")}
                />
                <Button type="submit" tone="secondary">
                  {t("marketplace.features.listings.ui.listingDetailPage.add.photos")}
                </Button>
              </Stack>
            </Form>
          </Card>

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
                      {t("marketplace.features.listings.ui.listingDetailPage.price")}
                      {entry.price_amount
                        ? formatMoney(entry.price_amount, "USD")
                        : formatMoney(listing.price_amount, "USD")}
                    </Text>
                    {entry.quantity_cap !== null ? (
                      <Text size="sm" tone="secondary">
                        {t("marketplace.features.listings.ui.listingDetailPage.quantity.cap")}
                        {entry.quantity_cap}
                      </Text>
                    ) : null}
                    <Text size="sm" tone="secondary">
                      {t("marketplace.features.listings.ui.listingDetailPage.marketplace.fee")}
                      {formatOptionalMoney(entry.marketplace_sales_fee_unit_amount)}
                    </Text>
                    <Text size="sm" tone="secondary">
                      {t("marketplace.features.listings.ui.listingDetailPage.seller.net")}
                      {formatOptionalMoney(entry.seller_net_unit_amount)}
                    </Text>
                    <Text size="sm" tone="secondary">
                      {t("marketplace.features.listings.ui.listingDetailPage.terms.schedule")}
                      {termsLabel({
                        agreement_id: entry.terms_agreement_id,
                        schedule_id: entry.terms_schedule_id,
                      })}
                    </Text>
                    <Text size="sm" tone="secondary">
                      {t("marketplace.features.listings.ui.listingDetailPage.terms.resolved.at")}{" "}
                      {formatTimestamp(entry.terms_resolved_at)}
                    </Text>
                  </Stack>
                ))
              ) : (
                <Text tone="secondary">{t("marketplace.features.listings.ui.listingDetailPage.no.fee.history")}</Text>
              )}
            </Stack>
          </Card>
        </ProgressiveDisclosure>
      </PageSection>

      <PageSection id="update-listing" title={t("marketplace.features.listings.ui.listingDetailPage.update.listing")}>
        <Stack gap={4}>
          <Card>
            <Form spacing="none" method="post">
              <Stack gap={3}>
                <TextInput
                  label={t("marketplace.features.listings.ui.listingDetailPage.price.2")}
                  name="priceAmount"
                  defaultValue={priceDraftAmount ?? listing.price_amount}
                  inputMode="decimal"
                  required
                />
                <HiddenInput
                  type="hidden"
                  name="feeQuoteFingerprint"
                  value={pricePreview?.fee_quote_fingerprint ?? listing.fee_quote_fingerprint}
                />
                <Stack gap={2}>
                  <Button type="submit" name="intent" value="update-price" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.save.price")}
                  </Button>
                  <Button type="submit" name="intent" value="preview-price" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.preview.fees")}
                  </Button>
                </Stack>
              </Stack>
            </Form>
            {pricePreview ? (
              <Stack gap={2}>
                <Text weight="semibold">
                  {t("marketplace.features.listings.ui.listingDetailPage.updated.fee.preview")}
                </Text>
                <Text size="sm" tone="secondary">
                  {t("marketplace.features.listings.ui.listingDetailPage.account.type")}
                  {pricePreview.account_type}
                </Text>
                <Text size="sm" tone="secondary">
                  {renderPreviewSummary(pricePreview)}
                </Text>
                <Text size="sm" tone="secondary">
                  {t("marketplace.features.listings.ui.listingDetailPage.basis.amount")}
                  {formatMoney(pricePreview.basis_amount, "USD")}
                </Text>
                <Text size="sm" tone="secondary">
                  {t("marketplace.features.listings.ui.listingDetailPage.terms.schedule.2")}
                  {termsLabel(pricePreview)}
                </Text>
              </Stack>
            ) : null}
          </Card>

          <Card>
            <Form spacing="none" method="post">
              <Stack gap={3}>
                <HiddenInput type="hidden" name="intent" value="update-quantity-cap" />
                <HiddenInput type="hidden" name="feeQuoteFingerprint" value={listing.fee_quote_fingerprint} />
                <NumberField
                  label={t("marketplace.features.listings.ui.listingDetailPage.quantity.cap.2")}
                  name="quantityCap"
                  defaultValue={listing.quantity_cap}
                  min={1}
                  required
                />
                <Text size="sm" tone="secondary">
                  {t("marketplace.features.listings.ui.listingDetailPage.quantity.cap.exposure.copy")}
                </Text>
                <Button type="submit" tone="secondary">
                  {t("marketplace.features.listings.ui.listingDetailPage.save.quantity.cap")}
                </Button>
              </Stack>
            </Form>
          </Card>

          <ProgressiveDisclosure
            title={t("marketplace.features.listings.ui.listingDetailPage.purchase.limits.copy")}
            summary={listingPurchaseLimitSummary(listing)}
            tone="info"
          >
            <Card>
              <Form spacing="none" method="post">
                <Stack gap={3}>
                  <HiddenInput type="hidden" name="intent" value="update-purchase-limits" />
                  <Inline>
                    <NumberField
                      label={t("marketplace.features.listings.ui.listingDetailPage.limit.per.order")}
                      name="maxUnitsPerOrder"
                      defaultValue={listing.max_units_per_order ?? undefined}
                      min={1}
                    />
                    <NumberField
                      label={t("marketplace.features.listings.ui.listingDetailPage.limit.per.day")}
                      name="maxUnitsPerDay"
                      defaultValue={listing.max_units_per_day ?? undefined}
                      min={1}
                    />
                    <NumberField
                      label={t("marketplace.features.listings.ui.listingDetailPage.limit.per.customer")}
                      name="maxUnitsPerCustomerAccount"
                      defaultValue={listing.max_units_per_customer_account ?? undefined}
                      min={1}
                    />
                  </Inline>
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.purchase.limits.copy")}
                  </Text>
                  <Button type="submit" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.save.purchase.limits")}
                  </Button>
                </Stack>
              </Form>
            </Card>
          </ProgressiveDisclosure>

          <Card>
            <Stack gap={3}>
              <Form spacing="none" method="post">
                <HiddenInput type="hidden" name="intent" value="publish" />
                <HiddenInput type="hidden" name="feeQuoteFingerprint" value={listing.fee_quote_fingerprint} />
                <Button type="submit" disabled={publishDisabled}>
                  {t("marketplace.features.listings.ui.listingDetailPage.publish.listing")}
                </Button>
                {listing.status !== "active" && listing.status !== "withdrawn" && !listing.product_measure_snapshot ? (
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.listings.ui.listingDetailPage.publish.requires.shipping.measure")}
                  </Text>
                ) : null}
              </Form>
              <Form spacing="none" method="post">
                <HiddenInput type="hidden" name="intent" value="pause" />
                <Button type="submit" tone="secondary" disabled={listing.status !== "active"}>
                  {t("marketplace.features.listings.ui.listingDetailPage.pause.listing")}
                </Button>
              </Form>
              <ModalDialog
                title={t("marketplace.features.listings.ui.listingDetailPage.withdraw.listing")}
                description={t("marketplace.features.listings.ui.listingDetailPage.withdraw.confirm.description")}
                trigger={
                  <Button type="button" tone="danger" disabled={listing.status === "withdrawn"}>
                    {t("marketplace.features.listings.ui.listingDetailPage.withdraw.listing")}
                  </Button>
                }
              >
                <Form spacing="none" method="post">
                  <Stack gap={3}>
                    <HiddenInput type="hidden" name="intent" value="withdraw" />
                    <Button type="submit" tone="danger">
                      {t("marketplace.features.listings.ui.listingDetailPage.withdraw.listing")}
                    </Button>
                  </Stack>
                </Form>
              </ModalDialog>
            </Stack>
          </Card>
        </Stack>
      </PageSection>
    </Page>
  );
}
