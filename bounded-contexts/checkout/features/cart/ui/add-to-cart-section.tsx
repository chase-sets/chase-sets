import { t } from "@chase-sets/localization";
import {
  Button,
  Card,
  NumberInput,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";

export function CheckoutAddToCartSection({
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
    <PageSection title={t("checkout.features.cart.ui.addToCartSection.add.to.cart")}>
      <Card>
        <form method="post">
          <Stack gap={3}>
            <input type="hidden" name="intent" value="add-to-cart" />
            <input type="hidden" name="catalogItemId" value={catalogItemId} />
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
            <input type="hidden" name="productSummary" value={productSummary ?? ""} />
            <Stack gap={1}>
              <Text weight="semibold">{itemTitle}</Text>
              <Text size="sm" tone="secondary">
                {productSummary ?? t("checkout.features.cart.ui.addToCartSection.standard.product")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("checkout.features.cart.ui.addToCartSection.matching.visible.listings.right.now")}{visibleListingCount}
              </Text>
              <Text size="sm" tone="secondary">
                {t("checkout.features.cart.ui.addToCartSection.same.seller.cards.earn.five.percent.toward.shipping")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("checkout.features.cart.ui.addToCartSection.cart.lines.capture.buyer.intent.exact")}</Text>
            </Stack>
            {errorMessage ? <Text>{errorMessage}</Text> : null}
            <NumberInput
              label={t("checkout.features.cart.ui.addToCartSection.quantity")}
              name="quantity"
              min="1"
              defaultValue="1"
              required
            />
            <Button type="submit">{t("checkout.features.cart.ui.addToCartSection.add.to.cart.2")}</Button>
          </Stack>
        </form>
      </Card>
    </PageSection>
  );
}
