import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  CheckoutLayout,
  CheckoutTrustPanel,
  Divider,
  EmptyState,
  Grid,
  LinkButton,
  NumberInput,
  OrderSummary,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type { CheckoutCartLine } from "./contracts";

function formatLineLabel(line: CheckoutCartLine) {
  return [line.item_title, line.item_subtitle, line.product_summary]
    .filter(Boolean)
    .join(" | ");
}

export function CheckoutCartPage({
  cartLines,
  errorMessage,
}: {
  cartLines: readonly CheckoutCartLine[];
  errorMessage?: string | null;
}) {
  const cartLineCount = cartLines.reduce((sum, line) => sum + line.quantity, 0);
  const cartContent = (
    <Stack gap={4}>
      {errorMessage ? (
        <Surface tone="subtle" elevated>
          <Stack gap={2}>
            <Badge tone="danger">{t("checkout.features.cart.ui.cartPage.checkout.issue")}</Badge>
            <Text>{errorMessage}</Text>
          </Stack>
        </Surface>
      ) : null}

      <PageSection
        title={t("checkout.features.cart.ui.cartPage.current.cart")}
        description={t("checkout.features.cart.ui.cartPage.review.quantities.before.checkout.snapshots.these")}
      >
        <Stack gap={3}>
          {cartLines.length === 0 ? (
            <EmptyState
              title={t("checkout.features.cart.ui.cartPage.your.cart.is.empty")}
              description={t("checkout.features.cart.ui.cartPage.browse.the.marketplace.and.add.a")}
              icon="cart"
            />
          ) : (
            cartLines.map((line) => (
              <Surface key={line.line_id} elevated>
                <Stack gap={4}>
                  <Grid columns={{ base: 1, md: 3 }} gap={4}>
                    <Stack gap={1}>
                      <Text weight="semibold">{formatLineLabel(line)}</Text>
                      <Text size="sm" tone="secondary">
                        {t("checkout.features.cart.ui.cartPage.catalog.item")}{line.catalog_catalog_item_id}
                      </Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">{t("checkout.features.cart.ui.cartPage.product")}</Text>
                      <Text weight="medium">{line.product_summary ?? t("checkout.features.cart.ui.cartPage.standard")}</Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">{t("checkout.features.cart.ui.cartPage.quantity")}</Text>
                      <Badge tone="accent">{line.quantity}</Badge>
                    </Stack>
                  </Grid>
                  <Divider />
                  <form method="post">
                    <Grid columns={{ base: 1, md: 3 }} gap={3} align="end">
                      <input type="hidden" name="intent" value="update-cart-line" />
                      <input type="hidden" name="lineId" value={line.line_id} />
                      <NumberInput
                        label={t("checkout.features.cart.ui.cartPage.quantity.2")}
                        name="quantity"
                        min="1"
                        defaultValue={String(line.quantity)}
                        required
                      />
                      <Button type="submit" leadingIcon="check">
                        {t("checkout.features.cart.ui.cartPage.update.quantity")}</Button>
                      <Button
                        type="submit"
                        name="intent"
                        value="remove-cart-line"
                        tone="danger"
                        leadingIcon="trash"
                      >
                        {t("checkout.features.cart.ui.cartPage.remove")}</Button>
                    </Grid>
                  </form>
                </Stack>
              </Surface>
            ))
          )}
        </Stack>
      </PageSection>
    </Stack>
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("checkout.features.cart.ui.cartPage.secure.checkout")}
        title={t("checkout.features.cart.ui.cartPage.cart")}
        description={t("checkout.features.cart.ui.cartPage.review.product.level.purchase.intent.before")}
      />

      {cartLines.length > 0 ? (
        <CheckoutLayout
          summary={
            <Stack gap={4}>
              <OrderSummary
                title={t("checkout.features.cart.ui.cartPage.cart.summary")}
                lines={[
                  { label: t("checkout.features.cart.ui.cartPage.items"), value: cartLineCount },
                  { label: t("checkout.features.cart.ui.cartPage.cart.lines"), value: cartLines.length },
                  { label: t("checkout.features.cart.ui.cartPage.pricing"), value: t("checkout.features.cart.ui.cartPage.calculated.during.checkout") },
                ]}
                total={t("checkout.features.cart.ui.cartPage.ready.for.checkout")}
                totalLabel={t("checkout.features.cart.ui.cartPage.cart.status")}
              />
              <CheckoutTrustPanel
                items={[
                  {
                    icon: "shield",
                    title: t("checkout.features.cart.ui.cartPage.buyer.protection"),
                    description: t("checkout.features.cart.ui.cartPage.eligible.orders.are.protected.through.payment"),
                  },
                  {
                    icon: "lock",
                    title: t("checkout.features.cart.ui.cartPage.secure.payment"),
                    description: t("checkout.features.cart.ui.cartPage.payment.starts.only.after.orders.are"),
                  },
                  {
                    icon: "truck",
                    title: t("checkout.features.cart.ui.cartPage.fulfillment.ready"),
                    description: t("checkout.features.cart.ui.cartPage.shipping.preference.is.captured.before.order"),
                  },
                ]}
              />
            </Stack>
          }
        >
          <Stack gap={4}>
            {cartContent}
            <PageSection id="checkout" title={t("checkout.features.cart.ui.cartPage.checkout")}>
              <Surface elevated glow>
                <Stack gap={3}>
                  <Text size="sm" tone="secondary">
                    {t("checkout.features.cart.ui.cartPage.continue.to.choose.shipping.and.create")}</Text>
                  <form method="post" action="/checkout/start">
                    <input type="hidden" name="source" value="cart" />
                    <Button type="submit" size="lg" leadingIcon="lock">
                      {t("checkout.features.cart.ui.cartPage.start.checkout")}</Button>
                  </form>
                </Stack>
              </Surface>
            </PageSection>
          </Stack>
        </CheckoutLayout>
      ) : (
        cartContent
      )}
    </Page>
  );
}
