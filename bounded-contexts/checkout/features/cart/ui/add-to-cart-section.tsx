import { t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  Button,
  Card,
  NumberField,
  PageSection,
  ProductOptions,
  Stack,
  Text,
  productOptionsFromSummary,
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
        <Form spacing="none" method="post">
          <Stack gap={3}>
            <HiddenInput type="hidden" name="intent" value="add-to-cart" />
            <HiddenInput type="hidden" name="catalogItemId" value={catalogItemId} />
            <HiddenInput type="hidden" name="productId" value={productId} />
            <HiddenInput type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
            <HiddenInput type="hidden" name="productSummary" value={productSummary ?? ""} />
            <Stack gap={1}>
              <Text weight="semibold">{itemTitle}</Text>
              {productSummary ? (
                <ProductOptions options={productOptionsFromSummary(productSummary)} variant="compact" />
              ) : (
                <Text size="sm" tone="secondary">
                  {t("checkout.features.cart.ui.addToCartSection.standard.product")}
                </Text>
              )}
              <Text size="sm" tone="secondary">
                {t("checkout.features.cart.ui.addToCartSection.matching.visible.listings.right.now")}
                {visibleListingCount}
              </Text>
              <Text size="sm" tone="secondary">
                {t("checkout.features.cart.ui.addToCartSection.same.seller.cards.earn.five.percent.toward.shipping")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("checkout.features.cart.ui.addToCartSection.cart.lines.capture.buyer.intent.exact")}
              </Text>
            </Stack>
            {errorMessage ? <Text>{errorMessage}</Text> : null}
            <NumberField
              label={t("checkout.features.cart.ui.addToCartSection.quantity")}
              name="quantity"
              min={1}
              defaultValue={1}
              required
            />
            <Button type="submit">{t("checkout.features.cart.ui.addToCartSection.add.to.cart.2")}</Button>
          </Stack>
        </Form>
      </Card>
    </PageSection>
  );
}
