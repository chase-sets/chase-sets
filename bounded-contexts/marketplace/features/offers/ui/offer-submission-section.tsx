import { t } from "@chase-sets/localization";
import {
  Button,
  Card,
  NumberInput,
  PageSection,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";

export function MarketplaceOfferSubmissionSection({
  catalogItemId,
  productId,
  itemTitle,
  selectedOptions,
  productSummary,
  visibleListingCount,
  errorMessage,
}: {
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  visibleListingCount: number;
  errorMessage?: string | null;
}) {
  return (
    <PageSection title={t("marketplace.features.offers.ui.offerSubmissionSection.make.an.offer")}>
      <Card>
        <form method="post">
          <Stack gap={3}>
            <input type="hidden" name="intent" value="submit-offer" />
            <input type="hidden" name="catalogItemId" value={catalogItemId} />
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
            <input type="hidden" name="productSummary" value={productSummary ?? ""} />
            <Stack gap={1}>
              <Text weight="semibold">{itemTitle}</Text>
              <Text size="sm" tone="secondary">
                {productSummary ?? t("marketplace.features.offers.ui.offerSubmissionSection.standard.product")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("marketplace.features.offers.ui.offerSubmissionSection.matching.visible.listings.for.this.product")}{visibleListingCount}
              </Text>
              <Text size="sm" tone="secondary">
                {t("marketplace.features.offers.ui.offerSubmissionSection.sellers.can.batch.same.buyer.offers.for.shipping.allowance")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("marketplace.features.offers.ui.offerSubmissionSection.offers.are.marketplace.wide.they.are")}</Text>
            </Stack>
            {errorMessage ? <Text>{errorMessage}</Text> : null}
            <TextInput
              label={t("marketplace.features.offers.ui.offerSubmissionSection.offer.price")}
              name="priceAmount"
              placeholder="24.99"
              inputMode="decimal"
              required
            />
            <NumberInput
              label={t("marketplace.features.offers.ui.offerSubmissionSection.quantity.requested")}
              name="quantityRequested"
              min="1"
              required
            />
            <Button type="submit">{t("marketplace.features.offers.ui.offerSubmissionSection.submit.offer")}</Button>
          </Stack>
        </form>
      </Card>
    </PageSection>
  );
}
