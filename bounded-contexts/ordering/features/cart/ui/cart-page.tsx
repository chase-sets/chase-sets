import {
  Button,
  Card,
  EmptyState,
  NumberInput,
  Page,
  PageHeader,
  PageSection,
  Stack,
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
  return (
    <Page>
      <PageHeader
        eyebrow="Buyer"
        title="Cart"
        description="Review product-level purchase intent before checkout resolves live marketplace supply."
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Current Cart">
        <Stack gap={3}>
          {cartLines.length === 0 ? (
            <EmptyState
              title="Your cart is empty"
              description="Browse the marketplace and add a product to start building a checkout."
              icon="cart"
            />
          ) : (
            cartLines.map((line) => (
              <Card key={line.line_id}>
                <Stack gap={3}>
                  <Stack gap={1}>
                    <Text weight="semibold">{formatLineLabel(line)}</Text>
                    <Text size="sm" tone="secondary">
                      Catalog item: {line.catalog_catalog_item_id}
                    </Text>
                  </Stack>

                  <form method="post">
                    <Stack gap={3}>
                      <input type="hidden" name="intent" value="update-cart-line" />
                      <input type="hidden" name="lineId" value={line.line_id} />
                      <NumberInput
                        label="Quantity"
                        name="quantity"
                        min="1"
                        defaultValue={String(line.quantity)}
                        required
                      />
                      <Stack gap={2}>
                        <Button type="submit">Update quantity</Button>
                        <Button
                          type="submit"
                          name="intent"
                          value="remove-cart-line"
                          tone="danger"
                        >
                          Remove
                        </Button>
                      </Stack>
                    </Stack>
                  </form>
                </Stack>
              </Card>
            ))
          )}
        </Stack>
      </PageSection>

      {cartLines.length > 0 ? (
        <PageSection title="Checkout">
          <Card>
            <form method="post">
              <Stack gap={3}>
                <input type="hidden" name="intent" value="checkout-cart" />
                <NativeSelect
                  label="Shipping option"
                  name="shippingOption"
                  defaultValue="standard"
                  items={[
                    { value: "standard", label: "Standard" },
                    { value: "expedited", label: "Expedited" },
                    { value: "priority", label: "Priority" },
                  ]}
                />
                <Button type="submit">Checkout cart</Button>
              </Stack>
            </form>
          </Card>
        </PageSection>
      ) : null}
    </Page>
  );
}
