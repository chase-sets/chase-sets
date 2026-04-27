import {
  Badge,
  Button,
  CheckoutLayout,
  CheckoutTrustPanel,
  Divider,
  EmptyState,
  Grid,
  NumberInput,
  OrderSummary,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
  NativeSelect,
} from "@chase-sets/design-system";
import type { OrderingCartLine } from "./contracts";

function formatLineLabel(line: OrderingCartLine) {
  return [line.item_title, line.item_subtitle, line.product_summary]
    .filter(Boolean)
    .join(" | ");
}

export function OrderingCartPage({
  cartLines,
  errorMessage,
}: {
  cartLines: readonly OrderingCartLine[];
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
        description="Review quantities before checkout resolves seller-specific supply and final pricing."
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
                  { label: "Pricing", value: "Resolved at checkout" },
                ]}
                total="Pending"
                totalLabel="Estimated total"
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
                    description: "Payment starts only after seller-specific orders are created.",
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
            <PageSection title="Checkout">
              <Surface elevated glow>
                <form method="post">
                  <Stack gap={3}>
                    <input type="hidden" name="intent" value="checkout-cart" />
                    <NativeSelect
                      label="Shipping option"
                      name="shippingOption"
                      defaultValue="standard"
                      items={[
                        { value: "standard", label: "Standard insured" },
                        { value: "expedited", label: "Expedited" },
                        { value: "priority", label: "Priority signature" },
                      ]}
                    />
                    <Button type="submit" size="lg" leadingIcon="lock">
                      Checkout cart
                    </Button>
                  </Stack>
                </form>
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
