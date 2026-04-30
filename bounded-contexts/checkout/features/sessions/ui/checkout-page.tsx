import {
  Badge,
  Button,
  CheckoutLayout,
  CheckoutTrustPanel,
  Divider,
  EmptyState,
  Grid,
  LinkButton,
  NativeSelect,
  OrderSummary,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { CheckoutSessionRow } from "../../../support/request-support/api-client";

function formatLineLabel(line: CheckoutSessionRow["lines"][number]) {
  return [line.itemTitle, line.itemSubtitle, line.productSummary]
    .filter(Boolean)
    .join(" | ");
}

export function CheckoutSessionPage({
  session,
  wallet,
  errorMessage,
  isSubmitting = false,
}: {
  session: CheckoutSessionRow;
  wallet?: { available_balance_amount: string; currency_code: string } | null;
  errorMessage?: string | null;
  isSubmitting?: boolean;
}) {
  const lines = session.lines;
  const lineCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const hasPayment = Boolean(session.payment_id);
  const summary = (
    <Stack gap={4}>
      <OrderSummary
        title="Checkout Summary"
        lines={[
          { label: "Items", value: lineCount },
          { label: "Lines", value: lines.length },
          { label: "Source", value: session.source_type === "buy-now" ? "Buy now" : "Cart" },
          {
            label: "Pricing",
            value: session.order_ids.length > 0
              ? "Order totals created"
              : "Calculated when purchases are created",
          },
          ...(wallet
            ? [
                {
                  label: "Available balance",
                  value: `${wallet.available_balance_amount} ${wallet.currency_code.toUpperCase()}`,
                },
              ]
            : []),
        ]}
        total={hasPayment ? "Payment ready" : "Ready to create purchases"}
        totalLabel="Checkout status"
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
  );

  return (
    <Page>
      <PageHeader
        eyebrow="Secure Checkout"
        title="Checkout"
        description="Choose shipping, create seller-specific purchases, and continue to payment."
        actions={
          <LinkButton href="/account/cart" tone="secondary">
            Back to cart
          </LinkButton>
        }
      />

      {lines.length === 0 ? (
        <EmptyState
          title="Your cart is empty"
          description="Add a product before starting checkout."
          icon="cart"
          actions={<LinkButton href="/search">Browse marketplace</LinkButton>}
        />
      ) : (
        <CheckoutLayout summary={summary}>
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
              title="Review Items"
              description="Checkout creates seller-specific purchases with final totals before payment starts."
            >
              <Stack gap={3}>
                {lines.map((line, index) => (
                  <Surface key={line.cartLineId ?? line.listingId ?? index} elevated>
                    <Grid columns={{ base: 1, md: 3 }} gap={4}>
                      <Stack gap={1}>
                        <Text weight="semibold">{formatLineLabel(line)}</Text>
                        <Text size="sm" tone="secondary">
                          Catalog item: {line.catalogItemId}
                        </Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">Product</Text>
                        <Text weight="medium">{line.productSummary ?? "Standard"}</Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">Quantity</Text>
                        <Badge tone="accent">{line.quantity}</Badge>
                      </Stack>
                    </Grid>
                  </Surface>
                ))}
              </Stack>
            </PageSection>

            {session.payment_id ? (
              <PageSection title="Payment">
                <Surface elevated glow>
                  <Stack gap={3}>
                    <Badge tone="success">Payment ready</Badge>
                    <Text>
                      Purchases have been created and payment is ready to continue.
                    </Text>
                    <LinkButton href={`/account/payments/${session.payment_id}`}>
                      Continue to payment
                    </LinkButton>
                  </Stack>
                </Surface>
              </PageSection>
            ) : (
              <PageSection title="Shipping">
                <Surface elevated glow>
                  <form method="post">
                    <Stack gap={3}>
                      <input type="hidden" name="intent" value="confirm-checkout" />
                      <NativeSelect
                        label="Shipping option"
                        name="shippingOption"
                        defaultValue={session.shipping_option}
                        items={[
                          { value: "standard", label: "Standard insured" },
                          { value: "expedited", label: "Expedited" },
                          { value: "priority", label: "Priority signature" },
                        ]}
                      />
                      <TextInput
                        label="Use balance"
                        name="requestedBalanceCreditAmount"
                        placeholder="0.00"
                        inputMode="decimal"
                        description={
                          wallet
                            ? `${wallet.available_balance_amount} ${wallet.currency_code.toUpperCase()} available for platform purchases`
                            : "Apply available wallet balance to this checkout"
                        }
                      />
                      <Divider />
                      <Button
                        type="submit"
                        size="lg"
                        leadingIcon="lock"
                        loading={isSubmitting}
                        disabled={isSubmitting}
                      >
                        {isSubmitting ? "Creating purchases..." : "Continue to payment"}
                      </Button>
                    </Stack>
                  </form>
                </Surface>
              </PageSection>
            )}
          </Stack>
        </CheckoutLayout>
      )}
    </Page>
  );
}
