import { useMemo, useState } from "react";
import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Checkbox,
  Grid,
  HiddenInput,
  KeyValueList,
  ProductCard,
  SelectionToolbar,
  SideSheet,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import { buyerLabel, formatMoney, moneyNumber } from "./sell-list-formatting";
import { ProductLineRow, SelectedOfferRow } from "./sell-list-line-rows";
import type { SellListInventoryItem, SellListOfferReview, SellListProductOfferReview } from "./sell-list-page-types";
import { useBulkOperationState } from "./use-bulk-operation-state";

type ReviewOffer = Readonly<{
  id: string;
  buyer: string;
  gross: string | null;
  quantity: number;
  terms: ReviewTerms | null;
}>;

type ReviewTerms = Readonly<{
  basis_amount?: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps?: number;
}>;

function shippingAllowance(terms: ReviewTerms | null) {
  if (!terms) {
    return "-";
  }
  const allowanceBps = terms.shipping_allowance_percentage_bps ?? 0;
  const percentage = allowanceBps / 100;
  const amount = moneyNumber(terms.basis_amount) * (allowanceBps / 10_000);
  return `${formatMoney(amount)} (${percentage}%)`;
}

function termsItems(terms: ReviewTerms | null) {
  return [
    {
      key: t("checkout.features.sellList.ui.sellListPage.marketplace.fee"),
      value: terms ? formatMoney(terms.marketplace_sales_fee_unit_amount) : "-",
    },
    {
      key: t("checkout.features.sellList.ui.sellListPage.seller.net"),
      value: terms ? formatMoney(terms.seller_net_unit_amount) : "-",
    },
    {
      key: t("checkout.features.sellList.ui.sellListPage.shipping.allowance"),
      value: shippingAllowance(terms),
    },
  ];
}

function TermsComparison({ review }: { review: SellListOfferReview }) {
  const standard = review.comparison?.standardPreview ?? null;
  if (!standard && !review.terms) {
    return null;
  }

  return (
    <Grid columns={{ base: 1, md: 2 }} gap={3}>
      <Surface tone="subtle" elevation="tinted" padding={3}>
        <Stack gap={2}>
          <Text weight="semibold">{t("checkout.features.sellList.ui.sellListPage.standard.terms")}</Text>
          <KeyValueList density="compact" variant="plain" items={termsItems(standard ?? review.terms)} />
        </Stack>
      </Surface>
      <Surface tone="subtle" elevation="tinted" padding={3}>
        <Stack gap={2}>
          <Text weight="semibold">{t("checkout.features.sellList.ui.sellListPage.seller.terms")}</Text>
          <KeyValueList density="compact" variant="plain" items={termsItems(review.terms)} />
        </Stack>
      </Surface>
    </Grid>
  );
}

function OfferOption({
  offer,
  checked,
  onCheckedChange,
}: {
  offer: ReviewOffer;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Surface tone="subtle" elevation="outlined" padding={3}>
      <Stack gap={3}>
        <Checkbox
          label={t("checkout.features.sellList.ui.sellListPage.select.offer", { buyer: offer.buyer })}
          description={t("checkout.features.sellList.ui.sellListPage.offer.quantity", { quantity: offer.quantity })}
          checked={checked}
          onCheckedChange={(next) => onCheckedChange(next === true)}
        />
        <KeyValueList
          density="compact"
          variant="plain"
          items={[
            {
              key: t("checkout.features.sellList.ui.sellListPage.offer"),
              value: formatMoney(offer.gross),
            },
            ...termsItems(offer.terms),
          ]}
        />
      </Stack>
    </Surface>
  );
}

function evidenceThumbnail(review: SellListOfferReview | SellListProductOfferReview | undefined) {
  if (!review) {
    return undefined;
  }
  const evidence = "offers" in review ? review.offers[0]?.evidence : review.evidence;
  const photo = evidence?.evidence.find((candidate) => candidate.status === "active");
  return (
    photo?.assetSet.variants.find((asset) => asset.role === "thumbnail")?.publicUrl ?? photo?.assetSet.source.publicUrl
  );
}

export function SellListReviewGrid({
  lines,
  offerReviewsByLineId,
  productOfferReviewsByLineId,
  inventoryByProductId,
  canAccept,
}: {
  lines: readonly CheckoutSellListLineRow[];
  offerReviewsByLineId: ReadonlyMap<string, SellListOfferReview>;
  productOfferReviewsByLineId: ReadonlyMap<string, SellListProductOfferReview>;
  inventoryByProductId: ReadonlyMap<string, readonly SellListInventoryItem[]>;
  canAccept: boolean;
}) {
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const activeLine = lines.find((line) => line.line_id === activeLineId) ?? null;
  const offersByLineId = useMemo(() => {
    const result = new Map<string, readonly ReviewOffer[]>();
    for (const line of lines) {
      if (line.line_type === "selected-offer") {
        const review = offerReviewsByLineId.get(line.line_id);
        result.set(
          line.line_id,
          line.offer_id
            ? [
                {
                  id: line.offer_id,
                  buyer: buyerLabel(line),
                  gross: line.offer_price_amount,
                  quantity: line.quantity,
                  terms: review?.terms ?? null,
                },
              ]
            : [],
        );
        continue;
      }
      const review = productOfferReviewsByLineId.get(line.line_id);
      result.set(
        line.line_id,
        (review?.offers ?? []).map(({ offer, terms }) => ({
          id: offer.offer_id,
          buyer: buyerLabel(offer),
          gross: offer.price_amount,
          quantity: offer.quantity_requested,
          terms,
        })),
      );
    }
    return result;
  }, [lines, offerReviewsByLineId, productOfferReviewsByLineId]);
  const offerIds = [...offersByLineId.values()].flatMap((offers) => offers.map((offer) => offer.id));
  const bulk = useBulkOperationState(offerIds);
  const activeOffers = activeLine ? (offersByLineId.get(activeLine.line_id) ?? []) : [];
  const bulkToolbar =
    bulk.selectedCount > 0 ? (
      <SelectionToolbar
        count={bulk.selectedCount}
        formatSelectedLabel={(count) =>
          t(
            count === 1
              ? "checkout.features.sellList.ui.sellListPage.offer.selected"
              : "checkout.features.sellList.ui.sellListPage.offers.selected",
            { count },
          )
        }
        actions={
          <>
            <Button
              type="submit"
              form="sell-list-checkout-form"
              name="intent"
              value="review-sell-list-checkout"
              disabled={!canAccept}
            >
              {t("checkout.features.sellList.ui.sellListPage.accept.selected")}
            </Button>
            <Button
              type="submit"
              form="sell-list-checkout-form"
              name="intent"
              value="decline-sell-list-offers"
              tone="danger"
            >
              {t("checkout.features.sellList.ui.sellListPage.decline.selected")}
            </Button>
            <Button type="button" tone="ghost" onClick={bulk.clear}>
              {t("checkout.features.sellList.ui.sellListPage.clear.selection")}
            </Button>
          </>
        }
      />
    ) : null;

  return (
    <Stack gap={4}>
      <Grid columns={{ base: 1, sm: 2, xl: 3 }} gap={4}>
        {lines.map((line) => {
          const offers = offersByLineId.get(line.line_id) ?? [];
          const bestOffer = offers.reduce<ReviewOffer | null>(
            (best, offer) =>
              !best ||
              moneyNumber(offer.terms?.seller_net_unit_amount) > moneyNumber(best.terms?.seller_net_unit_amount)
                ? offer
                : best,
            null,
          );
          const review =
            line.line_type === "selected-offer"
              ? offerReviewsByLineId.get(line.line_id)
              : productOfferReviewsByLineId.get(line.line_id);
          const estimatedNet = bestOffer
            ? moneyNumber(bestOffer.terms?.seller_net_unit_amount) * Math.min(line.quantity, bestOffer.quantity)
            : 0;
          return (
            <ProductCard
              key={line.line_id}
              title={line.item_title}
              subtitle={line.item_subtitle ?? line.product_summary ?? undefined}
              imageSrc={evidenceThumbnail(review)}
              imageAlt={line.item_title}
              imageFit="contain"
              status={
                <Badge tone={offers.length > 0 ? "success" : "warning"}>
                  {offers.length > 0
                    ? t(
                        offers.length === 1
                          ? "checkout.features.sellList.ui.sellListPage.offer.count.one"
                          : "checkout.features.sellList.ui.sellListPage.offer.count.many",
                        { count: offers.length },
                      )
                    : t("checkout.features.sellList.ui.sellListPage.no.ready.matching.offers")}
                </Badge>
              }
              price={t("checkout.features.sellList.ui.sellListPage.estimated.net", {
                amount: formatMoney(estimatedNet),
              })}
              meta={t("checkout.features.sellList.ui.sellListPage.card.summary", {
                quantity: line.quantity,
                offer: bestOffer ? formatMoney(bestOffer.gross) : "-",
              })}
              actionLabel={t("checkout.features.sellList.ui.sellListPage.review.offers.and.terms")}
              onSelect={() => setActiveLineId(line.line_id)}
              selectLabel={t("checkout.features.sellList.ui.sellListPage.review.item.offers.and.terms", {
                item: line.item_title,
              })}
            />
          );
        })}
      </Grid>

      {lines.flatMap((line) => {
        const review = productOfferReviewsByLineId.get(line.line_id);
        const defaultInventory = inventoryByProductId.get(line.product_id)?.[0] ?? null;
        if (line.line_type === "selected-offer") {
          const selectedReview = offerReviewsByLineId.get(line.line_id);
          return selectedReview?.terms?.fee_quote_fingerprint
            ? [
                <HiddenInput
                  key={`fee:${line.line_id}`}
                  form="sell-list-checkout-form"
                  type="hidden"
                  name={`offerFeeQuoteFingerprint:${line.line_id}`}
                  value={selectedReview.terms.fee_quote_fingerprint}
                />,
              ]
            : [];
        }
        const fallbackFields =
          activeLineId === line.line_id
            ? []
            : [
                <HiddenInput
                  key={`fallback:${line.line_id}`}
                  form="sell-list-checkout-form"
                  type="hidden"
                  name={`fallbackMode:${line.line_id}`}
                  value={
                    (review?.offers.length ?? 0) >= line.quantity
                      ? "none"
                      : defaultInventory
                        ? "create-listing"
                        : "none"
                  }
                />,
                <HiddenInput
                  key={`inventory:${line.line_id}`}
                  form="sell-list-checkout-form"
                  type="hidden"
                  name={`inventoryItemId:${line.line_id}`}
                  value={defaultInventory?.item_id ?? ""}
                />,
                <HiddenInput
                  key={`price:${line.line_id}`}
                  form="sell-list-checkout-form"
                  type="hidden"
                  name={`priceAmount:${line.line_id}`}
                  value={line.minimum_listing_price_amount ?? ""}
                />,
                <HiddenInput
                  key={`quantity:${line.line_id}`}
                  form="sell-list-checkout-form"
                  type="hidden"
                  name={`quantityCap:${line.line_id}`}
                  value={Math.min(line.quantity, defaultInventory?.available_quantity ?? line.quantity)}
                />,
              ];
        return [
          ...(review?.offers ?? []).flatMap(({ offer, terms }) => [
            <HiddenInput
              key={`offer:${line.line_id}:${offer.offer_id}`}
              form="sell-list-checkout-form"
              type="hidden"
              name={`productOfferId:${line.line_id}`}
              value={offer.offer_id}
            />,
            <HiddenInput
              key={`fee:${line.line_id}:${offer.offer_id}`}
              form="sell-list-checkout-form"
              type="hidden"
              name={`productOfferFeeQuoteFingerprint:${line.line_id}:${offer.offer_id}`}
              value={terms.fee_quote_fingerprint}
            />,
          ]),
          ...fallbackFields,
        ];
      })}

      {bulk.selectedIds.map((id) => (
        <HiddenInput key={id} form="sell-list-checkout-form" type="hidden" name="bulkOfferId" value={id} />
      ))}

      <SideSheet
        width="lg"
        open={activeLine !== null}
        onOpenChange={(open) => {
          if (!open) {
            setActiveLineId(null);
          }
        }}
        title={
          activeLine
            ? t("checkout.features.sellList.ui.sellListPage.item.offers.and.terms", { item: activeLine.item_title })
            : t("checkout.features.sellList.ui.sellListPage.review.offers.and.terms")
        }
        description={t("checkout.features.sellList.ui.sellListPage.drawer.description")}
      >
        {activeLine ? (
          <Stack gap={4}>
            <Stack gap={3}>
              {activeOffers.map((offer) => (
                <OfferOption
                  key={offer.id}
                  offer={offer}
                  checked={bulk.isSelected(offer.id)}
                  onCheckedChange={(checked) => bulk.toggle(offer.id, checked)}
                />
              ))}
            </Stack>
            {activeLine.line_type === "selected-offer" ? (
              <>
                {offerReviewsByLineId.get(activeLine.line_id) ? (
                  <TermsComparison review={offerReviewsByLineId.get(activeLine.line_id)!} />
                ) : null}
                <SelectedOfferRow line={activeLine} review={offerReviewsByLineId.get(activeLine.line_id)} />
              </>
            ) : (
              <ProductLineRow
                line={activeLine}
                review={productOfferReviewsByLineId.get(activeLine.line_id)}
                inventoryOptions={inventoryByProductId.get(activeLine.product_id) ?? []}
              />
            )}
            {bulk.selectedCount === 0 ? (
              <Button
                type="submit"
                form="sell-list-checkout-form"
                name="intent"
                value="review-sell-list-checkout"
                disabled={!canAccept}
              >
                {t("checkout.features.sellList.ui.sellListPage.continue.to.seller.checkout")}
              </Button>
            ) : null}
            {bulkToolbar}
          </Stack>
        ) : null}
      </SideSheet>

      {activeLine === null ? bulkToolbar : null}
    </Stack>
  );
}
