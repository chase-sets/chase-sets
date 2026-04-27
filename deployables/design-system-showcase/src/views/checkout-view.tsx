import {
  Badge,
  Button,
  CheckoutLayout,
  CheckoutTrustPanel,
  Divider,
  Grid,
  Heading,
  Icon,
  Inline,
  NativeSelect,
  OrderSummary,
  Page,
  PageHeader,
  PageStepper,
  ProductCard,
  RadioGroup,
  Stack,
  Surface,
  Text,
  TextInput
} from "@chase-sets/design-system";
import { demoProducts } from "../fixtures";

export function CheckoutView() {
  const product = demoProducts[0];

  return (
    <Page>
      <PageHeader
        eyebrow="Secure Checkout"
        title="Checkout"
        description="Shipping, delivery, payment, and buyer protection patterns for order completion."
      />
      <PageStepper
        items={[
          { label: "Cart", status: "complete" },
          { label: "Checkout", status: "current" },
          { label: "Confirmation", status: "upcoming" }
        ]}
      />
      <CheckoutLayout
        summary={
          <Stack gap={4}>
            <ProductCard
              title={product.title}
              subtitle={product.subtitle}
              price="$1,250.00"
              imageSrc={product.imageSrc}
              imageAlt={product.title}
              imageFit="contain"
              status={<Badge tone="info">1</Badge>}
            />
            <OrderSummary
              title="Order Summary"
              lines={[
                { label: "Item Price", value: "$1,250.00" },
                { label: "Shipping", value: "FREE" },
                { label: "Marketplace Fee", value: "$62.50" },
                { label: "Sales Tax", value: "$108.28" }
              ]}
              total="$1,420.78"
            />
            <CheckoutTrustPanel
              items={[
                { icon: "lock", title: "Secure Payment Hold", description: "Payment is held until the item is authenticated." },
                { icon: "badgeCheck", title: "Authenticity Verification", description: "Experts inspect every item before shipping." },
                { icon: "truck", title: "Insured Shipping", description: "Orders are tracked from vault to doorstep." }
              ]}
            />
          </Stack>
        }
      >
        <Stack gap={4}>
          <Surface elevated>
            <Stack gap={3}>
              <Inline gap={3}>
                <Badge tone="accent">1</Badge>
                <Heading level={3}>Shipping</Heading>
              </Inline>
              <Text tone="secondary">Where should we ship your order?</Text>
              <Grid columns={{ base: 1, md: 2 }} gap={3}>
                <TextInput label="Contact Email" defaultValue="alex@example.test" />
                <TextInput label="Full Name" defaultValue="Alex Example" />
              </Grid>
              <TextInput label="Address" defaultValue="123 Example Way" />
              <Grid columns={{ base: 1, md: 3 }} gap={3}>
                <TextInput label="City" defaultValue="Austin" />
                <NativeSelect
                  label="State"
                  defaultValue="TX"
                  items={[{ value: "TX", label: "Texas" }]}
                />
                <TextInput label="ZIP Code" defaultValue="78701" />
              </Grid>
            </Stack>
          </Surface>

          <Surface elevated>
            <Stack gap={3}>
              <Inline gap={3}>
                <Badge tone="accent">2</Badge>
                <Heading level={3}>Delivery</Heading>
              </Inline>
              <RadioGroup
                label="Shipping method"
                defaultValue="standard"
                items={[
                  { value: "standard", label: "Standard Insured", description: "Fully insured shipping with tracking." },
                  { value: "express", label: "Express Signature", description: "Expedited shipping with signature required." }
                ]}
              />
            </Stack>
          </Surface>

          <Surface elevated>
            <Stack gap={3}>
              <Inline gap={3}>
                <Badge tone="accent">3</Badge>
                <Heading level={3}>Payment</Heading>
              </Inline>
              <Text tone="secondary">All transactions are secure and encrypted.</Text>
              <TextInput label="Card Number" defaultValue="4242 4242 4242 4242" />
              <Grid columns={{ base: 1, md: 3 }} gap={3}>
                <TextInput label="Expiry Date" defaultValue="MM / YY" />
                <TextInput label="CVC" defaultValue="123" />
                <TextInput label="Name on Card" defaultValue="Alex Example" />
              </Grid>
            </Stack>
          </Surface>

          <Surface elevated>
            <Grid columns={{ base: 1, md: 3 }} gap={4}>
              <Inline gap={3}>
                <Icon name="shield" tone="accent" />
                <Stack gap={1}>
                  <Text weight="semibold">Buyer Protection</Text>
                  <Text size="sm" tone="secondary">Eligible refunds on every order.</Text>
                </Stack>
              </Inline>
              <Inline gap={3}>
                <Icon name="lock" tone="accent" />
                <Stack gap={1}>
                  <Text weight="semibold">Secure Checkout</Text>
                  <Text size="sm" tone="secondary">Encrypted payment handling.</Text>
                </Stack>
              </Inline>
              <Inline gap={3}>
                <Icon name="badgeCheck" tone="success" />
                <Stack gap={1}>
                  <Text weight="semibold">Authenticity Guarantee</Text>
                  <Text size="sm" tone="secondary">Expert verification before delivery.</Text>
                </Stack>
              </Inline>
            </Grid>
          </Surface>

          <Button size="lg" leadingIcon="lock">Complete Purchase</Button>
          <Divider />
          <Text size="sm" tone="secondary" align="center">
            Demo data is fictional and for visual validation only.
          </Text>
        </Stack>
      </CheckoutLayout>
    </Page>
  );
}
