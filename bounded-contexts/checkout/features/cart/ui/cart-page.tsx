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
            <Badge tone="danger">Checkout issue</Badge>
            <Text>{errorMessage}</Text>
          </Stack>
        </Surface>
      ) : null}

      <PageSection
        title="Current Cart"
        description="Review quantities before checkout snapshots these items and creates purchases grouped by seller account."
      >
        <Stack gap={3}>
          {cartLines.length === 0 ? (
            <EmptyState
              title="Your cart is empty"
              description="Browse the marketplace and add a product to start building a checkout."
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
                        Catalog item: {line.catalog_catalog_item_id}
                      </Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">Product</Text>
                      <Text weight="medium">{line.product_summary ?? "Standard"}</Text>
                    </Stack>
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">Quantity</Text>
                      <Badge tone="accent">{line.quantity}</Badge>
                    </Stack>
                  </Grid>
                  <Divider />
                  <form method="post">
                    <Grid columns={{ base: 1, md: 3 }} gap={3} align="end">
                      <input type="hidden" name="intent" value="update-cart-line" />
                      <input type="hidden" name="lineId" value={line.line_id} />
                      <NumberInput
                        label="Quantity"
                        name="quantity"
                        min="1"
                        defaultValue={String(line.quantity)}
                        required
                      />
                      <Button type="submit" leadingIcon="check">
                        Update quantity
                      </Button>
                      <Button
                        type="submit"
                        name="intent"
                        value="remove-cart-line"
                        tone="danger"
                        leadingIcon="trash"
                      >
                        Remove
                      </Button>
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
        eyebrow="Secure Checkout"
        title="Cart"
        description="Review product-level purchase intent before checkout resolves live marketplace supply, seller splits, and payment."
      />

      {cartLines.length > 0 ? (
        <CheckoutLayout
          summary={
            <Stack gap={4}>
              <OrderSummary
                title="Cart Summary"
                lines={[
                  { label: "Items", value: cartLineCount },
                  { label: "Cart lines", value: cartLines.length },
                  { label: "Pricing", value: "Calculated during checkout" },
                ]}
                total="Ready for checkout"
                totalLabel="Cart status"
              />
              <CheckoutTrustPanel
                items={[
                  {
                    icon: "shield",
                    title: "Buyer Protection",
                    description: "Eligible orders are protected through payment and fulfillment.",
                  },
                  {
                    icon: "lock",
                    title: "Secure Payment",
                    description: "Payment starts only after orders are grouped by seller account.",
                  },
                  {
                    icon: "truck",
                    title: "Fulfillment Ready",
                    description: "Shipping preference is captured before order creation.",
                  },
                ]}
              />
            </Stack>
          }
        >
          <Stack gap={4}>
            {cartContent}
            <PageSection id="checkout" title="Checkout">
              <Surface elevated glow>
                <Stack gap={3}>
                  <Text size="sm" tone="secondary">
                    Continue to choose shipping and create purchases grouped by seller account.
                  </Text>
                  <form method="post" action="/checkout/start">
                    <input type="hidden" name="source" value="cart" />
                    <Button type="submit" size="lg" leadingIcon="lock">
                      Start checkout
                    </Button>
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
