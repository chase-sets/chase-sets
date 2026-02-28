import { useState } from "react";
import {
  AdminShell,
  Badge,
  Button,
  Card,
  ChaseRoot,
  Checkbox,
  ConditionBadge,
  CurrencyInput,
  DataTable,
  DetailPanel,
  EmptyState,
  Fieldset,
  FileDropzone,
  FilterBar,
  FilterDrawer,
  FormSection,
  Grid,
  Heading,
  Inline,
  MarketplaceShell,
  MetricStrip,
  OrderSummary,
  Page,
  PageHeader,
  PageSection,
  PriceDisplay,
  type ColorMode,
  SearchInput,
  SearchResultsLayout,
  SegmentedControl,
  Select,
  SellerBadge,
  SplitPane,
  Stat,
  StatGrid,
  Surface,
  Switch,
  Tabs,
  Text,
  TextInput,
  Thumbnail,
  ToastRegion
} from "@chase-sets/design-system";

const marketplaceNav = [
  { key: "browse", label: "Browse", icon: "search" as const },
  { key: "sets", label: "Sets", icon: "spark" as const },
  { key: "cart", label: "Cart", icon: "cart" as const, badge: "3" },
  { key: "account", label: "Account", icon: "user" as const }
];

const adminNav = [
  { key: "dashboard", label: "Dashboard", icon: "dashboard" as const },
  { key: "inventory", label: "Inventory", icon: "package" as const },
  { key: "pricing", label: "Pricing", icon: "spark" as const },
  { key: "settings", label: "Settings", icon: "settings" as const }
];

const inventoryRows = [
  {
    sku: "CS-001",
    card: "Charizard ex - 199/165",
    condition: "NM" as const,
    price: 29.95,
    stock: 14
  },
  {
    sku: "CS-014",
    card: "Iono - 237/091",
    condition: "LP" as const,
    price: 12.5,
    stock: 32
  },
  {
    sku: "CS-104",
    card: "Mewtwo VSTAR - GG44",
    condition: "NM" as const,
    price: 9.25,
    stock: 7
  }
];

interface ShowcaseViewProps {
  colorMode: ColorMode;
  onColorModeChange: (value: ColorMode) => void;
}

function ColorModeToggle({
  colorMode,
  onColorModeChange
}: ShowcaseViewProps) {
  return (
    <Inline gap={2} align="center">
      <Text size="sm" tone="secondary">
        Theme
      </Text>
      <SegmentedControl
        value={colorMode}
        onValueChange={(value) => onColorModeChange(value as ColorMode)}
        items={[
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" }
        ]}
      />
    </Inline>
  );
}

function MarketplaceView() {
  return (
    <MarketplaceShell
      brand={<SellerBadge name="Chase Sets" verified />}
      topNavItems={marketplaceNav}
      bottomNavItems={marketplaceNav}
      activeKey="browse"
      actions={<Button tone="secondary">Sell cards</Button>}
      hero={
        <Surface elevated>
          <PageHeader
            eyebrow="Marketplace"
            title="Build a complete set without fighting the interface"
            description="Responsive search, transparent pricing, and buyer-first cart building are all composed from design-system primitives."
            actions={
              <>
                <Button>Start browsing</Button>
                <Button tone="secondary">View saved wants</Button>
              </>
            }
          />
        </Surface>
      }
      sidebar={
        <Surface>
          <Heading level={4}>Quick Filters</Heading>
          <Text tone="secondary">Card type, rarity, price band, condition, and seller trust all fit into the same primitive stack.</Text>
          <Inline gap={2}>
            <Badge tone="accent">Modern</Badge>
            <Badge tone="success">Verified</Badge>
            <Badge tone="info">Ships fast</Badge>
          </Inline>
        </Surface>
      }
    >
      <PageSection title="Search Results" description="Every result card is built from library exports only.">
        <FilterBar
          actions={
            <>
              <FilterDrawer
                trigger={<Button tone="secondary">Filters</Button>}
              >
                <Select
                  label="Condition"
                  items={[
                    { value: "nm", label: "Near mint" },
                    { value: "lp", label: "Light play" },
                    { value: "mp", label: "Moderate play" }
                  ]}
                />
                <Select
                  label="Seller rating"
                  items={[
                    { value: "all", label: "All sellers" },
                    { value: "trusted", label: "Trusted only" }
                  ]}
                />
              </FilterDrawer>
              <Button tone="ghost">Sort by price</Button>
            </>
          }
        >
          <SearchInput label="Find cards" placeholder="Search card, set, or variant" />
          <Select
            label="Rarity"
            items={[
              { value: "all", label: "All rarities" },
              { value: "rare", label: "Rare+" },
              { value: "common", label: "Common to uncommon" }
            ]}
          />
        </FilterBar>
        <SearchResultsLayout
          summary={
            <Text tone="secondary">
              428 matching listings across 36 sellers with consolidated shipping.
            </Text>
          }
        >
          <Grid columns={{ base: 1, md: 2, xl: 3 }} gap={4}>
            {inventoryRows.map((row) => (
              <Card key={row.sku}>
                <Thumbnail alt={row.card} ratio={4 / 5} />
                <PageSection>
                  <Inline gap={2}>
                    <ConditionBadge condition={row.condition} />
                    <Badge tone="success">In stock</Badge>
                  </Inline>
                  <Heading level={5}>{row.card}</Heading>
                  <Text tone="secondary">Sold by North Side Cards</Text>
                  <Inline gap={3}>
                    <PriceDisplay amount={row.price} emphasis />
                    <Text tone="secondary">{row.stock} available</Text>
                  </Inline>
                  <Button block>Add to cart</Button>
                </PageSection>
              </Card>
            ))}
          </Grid>
        </SearchResultsLayout>
      </PageSection>
      <PageSection title="Checkout Summary">
        <OrderSummary
          lines={[
            { label: "Cards", value: "$51.70" },
            { label: "Shipping", value: "$4.25" },
            { label: "Rebate", value: "-$1.15" }
          ]}
          total="$54.80"
        />
      </PageSection>
    </MarketplaceShell>
  );
}

function AdminView() {
  return (
    <AdminShell
      brand={<SellerBadge name="Chase Sets Ops" verified />}
      navItems={adminNav}
      activeKey="inventory"
      actions={<Button>New listing</Button>}
    >
      <Page>
        <PageHeader
          eyebrow="Admin"
          title="Inventory, pricing, and fulfillment in one responsive surface"
          description="The same library covers dashboard stats, dense data tables, and form-heavy listing editors."
        />
        <MetricStrip
          items={[
            { label: "Live listings", value: "8,420", trend: "+6.1% week over week" },
            { label: "Pending orders", value: "126", trend: "12 need same-day shipment" },
            { label: "Margin lift", value: "4.8%", trend: "vs competitor benchmark" },
            { label: "Low stock SKUs", value: "19", trend: "Restock recommended" }
          ]}
        />
        <PageSection title="Inventory Table">
          <DataTable
            rows={inventoryRows}
            columns={[
              {
                key: "sku",
                header: "SKU",
                cell: (row) => row.sku
              },
              {
                key: "card",
                header: "Card",
                mobileLabel: "Listing",
                cell: (row) => row.card
              },
              {
                key: "condition",
                header: "Condition",
                cell: (row) => <ConditionBadge condition={row.condition} />
              },
              {
                key: "price",
                header: "Price",
                align: "right",
                cell: (row) => <PriceDisplay amount={row.price} />
              },
              {
                key: "stock",
                header: "Stock",
                align: "right",
                cell: (row) => row.stock
              }
            ]}
          />
        </PageSection>
        <SplitPane
          primary={
            <FormSection
              title="Listing Editor"
              description="The listing editor composes entirely from form primitives and layout surfaces."
            >
              <Fieldset legend="Core listing data" description="Market-ready metadata with no custom CSS.">
                <TextInput label="Listing title" defaultValue="Charizard ex - 199/165" />
                <CurrencyInput label="Unit price" defaultValue="29.95" />
                <TextInput label="Quantity" type="number" defaultValue="14" />
              </Fieldset>
              <Fieldset legend="Operational settings" description="Bulk-safe admin controls.">
                <Checkbox
                  label="Eligible for rapid ship"
                  description="Prioritize this listing in same-day fulfillment queues."
                  defaultChecked
                />
                <Switch
                  label="Auto repricing"
                  description="Keep this listing aligned to the target spread."
                  defaultChecked
                />
                <FileDropzone
                  label="Product assets"
                  description="Optional scans or listing collateral."
                />
              </Fieldset>
            </FormSection>
          }
          secondary={
            <DetailPanel title="Panel Preview">
              <StatGrid>
                <Stat label="Expected margin" value="28%" trend="Healthy after shipping rebate" />
                <Stat label="Velocity" value="2.1/day" trend="Trending up" />
              </StatGrid>
              <PageSection title="Publish Health">
                <Text tone="secondary">
                  The component library keeps dense admin surfaces readable on mobile without branching into separate CSS.
                </Text>
                <EmptyState
                  title="No blocking issues"
                  description="Required metadata is present and pricing rules are valid."
                />
              </PageSection>
            </DetailPanel>
          }
        />
      </Page>
    </AdminShell>
  );
}

export function App() {
  const [colorMode, setColorMode] = useState<ColorMode>("system");
  const [showcaseMode, setShowcaseMode] = useState<"marketplace" | "admin">(
    "marketplace"
  );
  const [isDemoToastOpen, setIsDemoToastOpen] = useState(true);

  return (
    <ChaseRoot colorMode={colorMode}>
      <Page>
        <Surface elevated>
          <PageHeader
            eyebrow="Design system"
            title="One package, shared marketplace and admin surfaces"
            description="The showcase validates theme tokens, layout primitives, and responsive application shells from a single explicit stylesheet contract."
            actions={
              <ColorModeToggle
                colorMode={colorMode}
                onColorModeChange={setColorMode}
              />
            }
          />
        </Surface>
        <Tabs
          value={showcaseMode}
          onValueChange={(value) =>
            setShowcaseMode(value as "marketplace" | "admin")
          }
          items={[
            {
              value: "marketplace",
              label: "Marketplace",
              content: null
            },
            {
              value: "admin",
              label: "Admin",
              content: null
            }
          ]}
        />
      </Page>
      {showcaseMode === "marketplace" ? <MarketplaceView /> : <AdminView />}
      <ToastRegion
        items={[
          {
            id: "demo-toast",
            title: "Design system ready",
            description:
              "Marketplace and admin surfaces are rendering from a shared package with an explicit stylesheet import.",
            tone: "success",
            open: isDemoToastOpen,
            onOpenChange: setIsDemoToastOpen
          }
        ]}
      />
    </ChaseRoot>
  );
}
