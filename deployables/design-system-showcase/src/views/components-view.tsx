import type { ReactNode } from "react";
import {
  Badge,
  Button,
  ButtonGroup,
  Caption,
  CategoryTile,
  CheckoutLayout,
  CheckoutTrustPanel,
  CodeText,
  DataTable,
  Divider,
  Grid,
  Heading,
  Icon,
  IconButton,
  Inline,
  NativeSelect,
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
  TextInput,
  TokenSwatch
} from "@chase-sets/design-system";
import { demoProducts, showcaseIconNames } from "../fixtures";

const brandTokens = [
  { label: "Primary Blue", value: "#3882F6", color: "brandPrimary" },
  { label: "Accent Purple", value: "#8B5CF6", color: "brandSecondary" },
  { label: "Cyan", value: "#06B6D4", color: "cyan" },
  { label: "Indigo", value: "#6366F1", color: "indigo" }
] as const;

const surfaceTokens = [
  { label: "Background", value: "var(--color-background)", color: "background" },
  { label: "Surface 1", value: "var(--color-surface)", color: "surface" },
  { label: "Surface 2", value: "var(--color-surface-2)", color: "surface2" },
  { label: "Surface 3", value: "var(--color-surface-3)", color: "surface3" },
  { label: "Border", value: "var(--color-border)", color: "border" },
  { label: "Text Primary", value: "var(--color-text-primary)", color: "textPrimary" },
  { label: "Text Secondary", value: "var(--color-text-secondary)", color: "textSecondary" },
  { label: "Success", value: "var(--color-success)", color: "success" },
  { label: "Warning", value: "var(--color-warning)", color: "warning" },
  { label: "Danger", value: "var(--color-danger)", color: "danger" }
] as const;

const typeRows = [
  { style: "H1", example: "Build your collection", size: "48 / 56", weight: "700" },
  { style: "H2", example: "Discover rare finds", size: "36 / 44", weight: "600" },
  { style: "H3", example: "Featured collectibles", size: "28 / 36", weight: "600" },
  { style: "H4", example: "Top Categories", size: "22 / 28", weight: "600" },
  { style: "Body", example: "Buy, sell, and discover collectibles.", size: "16 / 24", weight: "400" },
  { style: "Small", example: "Shipping protection included.", size: "14 / 20", weight: "400" },
  { style: "Caption", example: "Joined 100,000+ collectors", size: "12 / 16", weight: "400" }
];

const spacingRows = [
  { label: "0", value: "0px" },
  { label: "1", value: "4px" },
  { label: "2", value: "8px" },
  { label: "3", value: "12px" },
  { label: "4", value: "16px" },
  { label: "6", value: "24px" },
  { label: "8", value: "32px" },
  { label: "12", value: "48px" }
];

function SectionCard({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Surface elevated>
      <Stack gap={4}>
        <Heading level={3}>{title}</Heading>
        {children}
      </Stack>
    </Surface>
  );
}

export function ComponentsView() {
  return (
    <Page>
      <PageHeader
        eyebrow="Chase Sets Design System"
        title="Clean, modern collectibles marketplace."
        description="The canonical UI layer for marketplace, seller, checkout, and admin surfaces."
      />

      <Grid columns={{ base: 1, xl: 2 }} gap={4} align="start">
        <SectionCard title="Brand Colors">
          <Grid columns={{ base: 2, md: 4 }} gap={3}>
            {brandTokens.map((token) => (
              <TokenSwatch
                key={token.label}
                label={token.label}
                value={token.value}
                color={token.color}
              />
            ))}
          </Grid>
          <Divider />
          <Grid columns={{ base: 2, md: 5 }} gap={3}>
            {surfaceTokens.map((token) => (
              <TokenSwatch
                key={token.label}
                label={token.label}
                value={token.value}
                color={token.color}
              />
            ))}
          </Grid>
        </SectionCard>

        <SectionCard title="Typography">
          <Stack gap={2}>
            <Heading level={1}>Build your collection</Heading>
            <Heading level={2}>Discover rare finds</Heading>
            <Heading level={3}>Featured collectibles</Heading>
            <Text>Buy, sell, and discover collectibles with confidence.</Text>
            <Caption>Joined 100,000+ collectors</Caption>
          </Stack>
          <DataTable
            density="compact"
            rows={typeRows}
            columns={[
              { key: "style", header: "Style", cell: (row) => row.style },
              { key: "example", header: "Example", cell: (row) => row.example },
              { key: "size", header: "Size / Line", cell: (row) => row.size },
              { key: "weight", header: "Weight", cell: (row) => row.weight }
            ]}
          />
        </SectionCard>
      </Grid>

      <PageSection title="Actions / States">
        <Surface elevated>
          <Grid columns={{ base: 1, lg: 3 }} gap={4} align="start">
            <Stack gap={3}>
              <Heading level={4}>Buttons</Heading>
              <ButtonGroup>
                <Button>Get Started</Button>
                <Button tone="secondary">Explore Marketplace</Button>
                <Button tone="ghost">Start Selling</Button>
                <Button disabled>Disabled</Button>
              </ButtonGroup>
              <Inline gap={2}>
                <IconButton label="Search" icon="search" />
                <IconButton label="Save" icon="heart" tone="secondary" />
                <IconButton label="Settings" icon="settings" tone="ghost" />
              </Inline>
            </Stack>

            <Stack gap={3}>
              <Heading level={4}>Badges</Heading>
              <Inline gap={2}>
                <Badge tone="info">Verified</Badge>
                <Badge tone="warning">Hot</Badge>
                <Badge tone="success">New</Badge>
                <Badge tone="danger">Alert</Badge>
                <Badge>Outlined</Badge>
              </Inline>
            </Stack>

            <Stack gap={3}>
              <Heading level={4}>Navigation</Heading>
              <SegmentedControl
                value="all"
                items={[
                  { value: "all", label: "All" },
                  { value: "cards", label: "Cards" },
                  { value: "comics", label: "Comics" },
                  { value: "figures", label: "Figures" }
                ]}
              />
              <Text size="sm" tone="secondary">
                Focus, hover, active, and disabled states are token-driven.
              </Text>
            </Stack>
          </Grid>
        </Surface>
      </PageSection>

      <PageSection title="Inputs / Forms">
        <Surface elevated>
          <Grid columns={{ base: 1, lg: 2 }} gap={4}>
            <SearchInput label="Search Bar" placeholder="Search for cards, comics, figures..." />
            <TextInput label="Text Field" placeholder="Enter item title" />
            <Select
              label="Radix Select"
              items={[
                { value: "all", label: "All Categories" },
                { value: "cards", label: "Trading Cards" }
              ]}
            />
            <NativeSelect
              label="Native Select"
              placeholder="Condition"
              items={[
                { value: "mint", label: "Mint" },
                { value: "near-mint", label: "Near Mint" }
              ]}
            />
            <Inline gap={4}>
              <Switch label="Toggle" defaultChecked />
              <RadioGroup
                label="Auction mode"
                defaultValue="auction"
                items={[{ value: "auction", label: "Auction" }]}
              />
            </Inline>
          </Grid>
        </Surface>
      </PageSection>

      <PageSection title="Cards / Marketplace Components">
        <Grid columns={{ base: 1, md: 4 }} gap={4} align="start">
          <ProductCard
            href="#product-card"
            title={demoProducts[0].title}
            subtitle={demoProducts[0].subtitle}
            price={demoProducts[0].price}
            imageSrc={demoProducts[0].imageSrc}
            imageAlt={demoProducts[0].title}
            imageFit="contain"
            status={<Badge tone="info">Verified</Badge>}
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
              <CodeText>ProductCard href/onSelect</CodeText>
            </Stack>
          </Surface>
        </Grid>
      </PageSection>

      <PageSection title="Spacing / Layout">
        <Surface elevated>
          <Grid columns={{ base: 2, md: 4 }} gap={3}>
            {spacingRows.map((row) => (
              <Stat key={row.label} label={`Space ${row.label}`} value={row.value} />
            ))}
          </Grid>
          <Divider />
          <StatGrid columns={{ base: 1, md: 4 }}>
            <Stat label="Control Radius" value="12px" />
            <Stat label="Card Radius" value="16px" />
            <Stat label="Grid Max" value="12 Col" />
            <Stat label="Density" value="Compact" />
          </StatGrid>
        </Surface>
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
    </Page>
  );
}
