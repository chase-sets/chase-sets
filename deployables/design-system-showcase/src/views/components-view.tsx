import {
  Badge,
  Button,
  ButtonGroup,
  CategoryTile,
  CheckoutLayout,
  CheckoutTrustPanel,
  Checkbox,
  Divider,
  Grid,
  Heading,
  Icon,
  IconButton,
  Inline,
  OrderSummary,
  Page,
  PageHeader,
  PageSection,
  ProductCard,
  RadioGroup,
  SearchInput,
  SegmentedControl,
  Select,
  Stack,
  Stat,
  StatGrid,
  Surface,
  Switch,
  Text,
  TextInput
} from "@chase-sets/design-system";
import { demoProducts, showcaseIconNames } from "../fixtures";

export function ComponentsView() {
  return (
    <Page>
      <PageHeader
        eyebrow="Chase Sets Design System"
        title="Clean, modern collectibles marketplace."
        description="Built for collectors. Designed for trust, discovery, and action."
      />

      <Grid columns={{ base: 1, lg: 2 }} gap={4}>
        <Surface elevated>
          <Stack gap={4}>
            <Heading level={3}>Color System</Heading>
            <Grid columns={{ base: 2, md: 4 }} gap={3}>
              <Surface tone="accent">Primary Blue</Surface>
              <Surface tone="accent">Accent Purple</Surface>
              <Surface tone="muted">Surface</Surface>
              <Surface tone="subtle">Border</Surface>
            </Grid>
            <Divider />
            <Heading level={3}>Buttons</Heading>
            <ButtonGroup>
              <Button>Get Started</Button>
              <Button tone="secondary">Explore Marketplace</Button>
              <Button tone="ghost">Start Selling</Button>
              <IconButton label="Favorite" icon="heart" />
            </ButtonGroup>
            <Inline gap={2}>
              <Badge tone="info">Verified</Badge>
              <Badge tone="warning">Hot</Badge>
              <Badge tone="success">New</Badge>
              <Badge>Outlined</Badge>
            </Inline>
          </Stack>
        </Surface>

        <Surface elevated>
          <Stack gap={4}>
            <Heading level={3}>Typography</Heading>
            <Heading level={1}>Build your collection</Heading>
            <Heading level={2}>Discover rare finds</Heading>
            <Heading level={3}>Featured collectibles</Heading>
            <Text>Buy, sell, and discover collectibles with confidence.</Text>
            <Text size="sm" tone="secondary">
              Shipping protection and secure payments included.
            </Text>
          </Stack>
        </Surface>
      </Grid>

      <PageSection title="Inputs / Forms">
        <Surface elevated>
          <Grid columns={{ base: 1, md: 2 }} gap={4}>
            <SearchInput label="Search Bar" placeholder="Search for cards, comics, figures..." />
            <TextInput label="Text Field" placeholder="Enter item title" />
            <Select
              label="Dropdown"
              items={[
                { value: "all", label: "All Categories" },
                { value: "cards", label: "Trading Cards" }
              ]}
            />
            <Select
              label="Select"
              items={[
                { value: "mint", label: "Mint" },
                { value: "near-mint", label: "Near Mint" }
              ]}
            />
            <SegmentedControl
              value="all"
              items={[
                { value: "all", label: "All" },
                { value: "cards", label: "Cards" },
                { value: "comics", label: "Comics" },
                { value: "figures", label: "Figures" }
              ]}
            />
            <Inline gap={4}>
              <Checkbox label="Accept terms and conditions" defaultChecked />
              <Switch label="Toggle" defaultChecked />
            </Inline>
          </Grid>
        </Surface>
      </PageSection>

      <PageSection title="Cards / Marketplace Components">
        <Grid columns={{ base: 1, md: 4 }} gap={4} align="start">
          <ProductCard
            title={demoProducts[0].title}
            subtitle={demoProducts[0].subtitle}
            price={demoProducts[0].price}
            imageSrc={demoProducts[0].imageSrc}
            imageAlt={demoProducts[0].title}
            imageFit="contain"
            status={<Badge tone="info">Verified</Badge>}
            actions={<IconButton label="Save" icon="heart" size="sm" />}
          />
          <CategoryTile icon="cards" label="Trading Cards" detail="120K+ items" />
          <Stat label="Active Collectors" value="100K+" icon={<Icon name="users" />} />
          <Surface elevated>
            <Stack gap={3}>
              <Inline gap={2}>
                <Icon name="star" tone="warning" />
                <Icon name="star" tone="warning" />
                <Icon name="star" tone="warning" />
                <Icon name="star" tone="warning" />
                <Icon name="star" tone="warning" />
              </Inline>
              <Text size="sm" tone="secondary">
                Chase Sets is the best marketplace I have used.
              </Text>
            </Stack>
          </Surface>
        </Grid>
      </PageSection>

      <PageSection title="Iconography">
        <Surface>
          <Inline gap={3}>
            {showcaseIconNames.map((name) => (
              <Icon key={name} name={name} tone="accent" />
            ))}
          </Inline>
        </Surface>
      </PageSection>

      <PageSection title="Checkout Pattern">
        <CheckoutLayout
          summary={
            <Stack gap={4}>
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
                  { icon: "lock", title: "Secure Payment Hold", description: "Your payment is held securely until the item is authenticated." },
                  { icon: "badgeCheck", title: "Authenticity Verification", description: "Experts inspect every item before it ships." },
                  { icon: "truck", title: "Insured Shipping", description: "Orders are tracked from vault to doorstep." }
                ]}
              />
            </Stack>
          }
        >
          <Stack gap={4}>
            <Surface elevated>
              <Stack gap={3}>
                <Heading level={3}>Shipping</Heading>
                <Grid columns={{ base: 1, md: 2 }} gap={3}>
                  <TextInput label="Contact Email" defaultValue="alex@example.test" />
                  <TextInput label="Full Name" defaultValue="Alex Example" />
                </Grid>
                <TextInput label="Address" defaultValue="123 Example Way" />
              </Stack>
            </Surface>
            <Surface elevated>
              <Stack gap={3}>
                <Heading level={3}>Delivery</Heading>
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
            <Button size="lg" leadingIcon="lock">Complete Purchase</Button>
          </Stack>
        </CheckoutLayout>
      </PageSection>

      <StatGrid columns={{ base: 1, md: 4 }}>
        <Stat label="Spacing Base" value="8px" />
        <Stat label="Radius" value="12px" />
        <Stat label="Elevation" value="Glow" />
        <Stat label="Grid" value="12 Col" />
      </StatGrid>
    </Page>
  );
}
