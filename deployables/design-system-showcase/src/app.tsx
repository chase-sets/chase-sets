import { useState } from "react";
import {
  Accordion,
  ActivityList,
  AdminShell,
  AlertDialog,
  AspectRatio,
  Avatar,
  Badge,
  Banner,
  Box,
  Breadcrumbs,
  BulkActionBar,
  Button,
  Caption,
  Card,
  Center,
  ChaseRoot,
  Checkbox,
  CheckboxGroup,
  CheckoutLayout,
  Cluster,
  CodeText,
  type ColorMode,
  ColorModeToggle as DesignSystemColorModeToggle,
  Combobox,
  ConditionBadge,
  Container,
  CopyButton,
  CurrencyInput,
  DataTable,
  DateInput,
  DetailPanel,
  Dialog,
  Divider,
  Drawer,
  EmptyState,
  EmptyStateIllustration,
  Field,
  Fieldset,
  FileDropzone,
  FilterBar,
  FilterDrawer,
  FormSection,
  Grid,
  Heading,
  HelperText,
  Icon,
  IconButton,
  ImageGallery,
  Inline,
  InlineMessage,
  Inset,
  InspectorLayout,
  KeyValueList,
  Label,
  LinkButton,
  LinkText,
  List,
  LoadingSpinner,
  MarketplaceShell,
  Menu,
  MetricStrip,
  NavRail,
  NumberInput,
  OrderSummary,
  Page,
  PageHeader,
  PageSection,
  PageStepper,
  Pagination,
  PasswordInput,
  Popover,
  PriceDisplay,
  ProgressBar,
  Quote,
  RadioGroup,
  Rating,
  RecordPage,
  ScrollArea,
  SearchInput,
  SearchResultsLayout,
  SegmentedControl,
  Select,
  SelectionToolbar,
  SellerBadge,
  Skeleton,
  Slider,
  Spacer,
  SplitPane,
  Stack,
  Stat,
  StatGrid,
  StatusPill,
  Surface,
  Switch,
  Table,
  Tabs,
  Tag,
  TagInput,
  Text,
  TextInput,
  Textarea,
  Thumbnail,
  Timeline,
  ToastRegion,
  Tooltip,
  VisuallyHidden,
  Wizard
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
  const [cartPage, setCartPage] = useState(3);
  const [selectedSet, setSelectedSet] = useState<string | undefined>();

  return (
    <MarketplaceShell
      brand={<SellerBadge name="Chase Sets" verified />}
      topNavItems={marketplaceNav}
      bottomNavItems={marketplaceNav}
      activeKey="browse"
      actions={
        <Inline gap={2}>
          <Tooltip content="View your saved want lists">
            <IconButton label="Saved wants" icon="spark" />
          </Tooltip>
          <LinkButton href="#sell" tone="secondary">Sell cards</LinkButton>
        </Inline>
      }
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
        <Stack gap={4}>
          <Surface>
            <Heading level={4}>Quick Filters</Heading>
            <Text tone="secondary">Card type, rarity, price band, condition, and seller trust all fit into the same primitive stack.</Text>
            <Inline gap={2}>
              <Tag tone="accent" onRemove={() => {}}>Modern</Tag>
              <Tag tone="success" onRemove={() => {}}>Verified</Tag>
              <Badge tone="info">Ships fast</Badge>
            </Inline>
          </Surface>
          <Surface>
            <Heading level={5}>Top Sellers</Heading>
            <Stack gap={3}>
              <Inline gap={2}>
                <Avatar name="North Side Cards" size="sm" />
                <Stack gap={0}>
                  <Text size="sm" weight="semibold">North Side Cards</Text>
                  <Caption>4.9 stars - 2,400 sales</Caption>
                </Stack>
              </Inline>
              <Inline gap={2}>
                <Avatar name="Gem Mint TCG" size="sm" />
                <Stack gap={0}>
                  <Text size="sm" weight="semibold">Gem Mint TCG</Text>
                  <Caption>4.8 stars - 1,800 sales</Caption>
                </Stack>
              </Inline>
            </Stack>
          </Surface>
          <Surface>
            <Heading level={5}>Browse by Set</Heading>
            <Combobox
              label="Set"
              hideLabel
              items={[
                { value: "sv8", label: "Surging Sparks" },
                { value: "sv7", label: "Stellar Crown" },
                { value: "sv6", label: "Twilight Masquerade" },
                { value: "sv5", label: "Temporal Forces" }
              ]}
              value={selectedSet}
              onValueChange={setSelectedSet}
              placeholder="Search sets..."
            />
          </Surface>
        </Stack>
      }
    >
      <PageSection title="Search Results" description="Every result card is built from library exports only.">
        <Breadcrumbs
          items={[
            { label: "Home", href: "#" },
            { label: "Pokemon TCG", href: "#" },
            { label: "Surging Sparks" }
          ]}
        />
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
              <Popover
                trigger={<Button tone="ghost">Sort</Button>}
                title="Sort listings"
              >
                <RadioGroup
                  label="Sort order"
                  hideLabel
                  items={[
                    { value: "price-asc", label: "Price: low to high" },
                    { value: "price-desc", label: "Price: high to low" },
                    { value: "recent", label: "Recently listed" }
                  ]}
                  defaultValue="price-asc"
                />
              </Popover>
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
            <Inline gap={3} align="center">
              <Text tone="secondary">
                428 matching listings across 36 sellers with consolidated shipping.
              </Text>
              <StatusPill tone="success">Live</StatusPill>
            </Inline>
          }
        >
          <Grid columns={{ base: 1, sm: 2, lg: 3, xl: 4 }} gap={3}>
            {inventoryRows.map((row) => (
              <Card key={row.sku}>
                <Thumbnail alt={row.card} ratio={1} />
                <Stack gap={3}>
                  <Inline gap={2}>
                    <ConditionBadge condition={row.condition} />
                    <Badge tone="success">In stock</Badge>
                  </Inline>
                  <Heading level={5}>{row.card}</Heading>
                  <Inline gap={2}>
                    <Avatar name="North Side Cards" size="sm" />
                    <LinkText href="#">North Side Cards</LinkText>
                  </Inline>
                  <Inline gap={3}>
                    <PriceDisplay amount={row.price} />
                    <Text size="sm" tone="secondary">{row.stock} available</Text>
                  </Inline>
                  <Tooltip content="Add this card to your cart">
                    <Button block>Add to cart</Button>
                  </Tooltip>
                </Stack>
              </Card>
            ))}
          </Grid>
        </SearchResultsLayout>
        <Pagination page={cartPage} totalPages={48} onPageChange={setCartPage} />
      </PageSection>

      <PageSection title="Checkout Flow">
        <PageStepper
          items={[
            { label: "Cart review", description: "Verify items and quantities", status: "complete" },
            { label: "Shipping", description: "Choose delivery method", status: "current" },
            { label: "Payment", description: "Secure checkout", status: "upcoming" }
          ]}
        />
        <CheckoutLayout
          summary={
            <OrderSummary
              lines={[
                { label: "Cards (3)", value: "$51.70" },
                { label: "Shipping", value: "$4.25" },
                { label: "Rebate", value: "-$1.15" }
              ]}
              total="$54.80"
            />
          }
        >
          <FormSection title="Shipping Details" description="Where should we send your cards?">
            <TextInput label="Full name" defaultValue="Todd S." />
            <TextInput label="Address" placeholder="123 Main St" />
            <Inline gap={3}>
              <TextInput label="City" placeholder="Chicago" />
              <TextInput label="ZIP" placeholder="60601" />
            </Inline>
            <DateInput label="Preferred delivery date" />
          </FormSection>
        </CheckoutLayout>
      </PageSection>
    </MarketplaceShell>
  );
}

function AdminView() {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [sliderValue, setSliderValue] = useState(75);
  const [selectedItems, setSelectedItems] = useState(2);

  return (
    <AdminShell
      brand={<SellerBadge name="Chase Sets Ops" verified />}
      navItems={adminNav}
      activeKey="inventory"
      actions={
        <Inline gap={2}>
          <Menu
            trigger={<IconButton label="Actions" icon="menu" />}
            items={[
              { key: "export", label: "Export inventory", description: "Download as CSV" },
              { key: "import", label: "Bulk import", description: "Upload listing spreadsheet" },
              { key: "archive", label: "Archive sold", description: "Move zero-stock to archive", destructive: true }
            ]}
          />
          <Button>New listing</Button>
        </Inline>
      }
    >
      <Page>
        <PageHeader
          eyebrow="Admin"
          title="Inventory, pricing, and fulfillment in one responsive surface"
          description="The same library covers dashboard stats, dense data tables, and form-heavy listing editors."
        />

        <Banner
          tone="info"
          title="Platform maintenance scheduled"
          description="Marketplace indexing will be paused Sunday 2am-4am CST. Listings remain live."
          actions={<Button tone="secondary" size="sm">View details</Button>}
        />

        <MetricStrip
          items={[
            { label: "Live listings", value: "8,420", trend: "+6.1% week over week" },
            { label: "Pending orders", value: "126", trend: "12 need same-day shipment" },
            { label: "Margin lift", value: "4.8%", trend: "vs competitor benchmark" },
            { label: "Low stock SKUs", value: "19", trend: "Restock recommended" }
          ]}
        />

        <PageSection title="Fulfillment Progress">
          <Grid columns={{ base: 1, md: 2 }} gap={4}>
            <Card>
              <Stack gap={3}>
                <Text weight="semibold">Daily shipment quota</Text>
                <ProgressBar value={sliderValue} tone="accent" />
                <Caption>{sliderValue} of 100 orders shipped today</Caption>
              </Stack>
            </Card>
            <Card>
              <Stack gap={3}>
                <Text weight="semibold">Processing pipeline</Text>
                <Inline gap={2}>
                  <LoadingSpinner size="sm" label="Syncing" />
                  <Caption>14 orders syncing with carrier API</Caption>
                </Inline>
                <Skeleton height="sm" />
                <Skeleton height="md" />
              </Stack>
            </Card>
          </Grid>
        </PageSection>

        <PageSection title="Inventory Table">
          <DataTable
            rows={inventoryRows}
            columns={[
              {
                key: "sku",
                header: "SKU",
                cell: (row) => <CodeText>{row.sku}</CodeText>
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
          {selectedItems > 0 && (
            <BulkActionBar
              count={selectedItems}
              actions={
                <>
                  <Button tone="secondary" size="sm" onClick={() => setSelectedItems(0)}>Deselect</Button>
                  <Button tone="danger" size="sm" onClick={() => setShowDeleteDialog(true)}>Remove listings</Button>
                </>
              }
            />
          )}
          <SelectionToolbar
            count={3}
            actions={
              <>
                <Button tone="secondary" size="sm">Reprice</Button>
                <Button tone="secondary" size="sm">Export</Button>
              </>
            }
          />
        </PageSection>

        <InspectorLayout
          main={
            <FormSection
              title="Listing Editor"
              description="The listing editor composes entirely from form primitives and layout surfaces."
            >
              <Fieldset legend="Core listing data" description="Market-ready metadata with no custom CSS.">
                <TextInput label="Listing title" defaultValue="Charizard ex - 199/165" />
                <CurrencyInput label="Unit price" defaultValue="29.95" />
                <NumberInput label="Quantity" defaultValue="14" />
                <Textarea label="Seller notes" placeholder="Condition details, special offers..." rows={3} />
              </Fieldset>
              <Fieldset legend="Categorization" description="Help buyers find this listing.">
                <CheckboxGroup
                  label="Listing tags"
                  items={[
                    { value: "chase", label: "Chase card", description: "High-demand pull" },
                    { value: "alt-art", label: "Alternate art" },
                    { value: "promo", label: "Promo / event exclusive" }
                  ]}
                  values={["chase"]}
                />
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
                <Slider
                  label="Target margin"
                  value={sliderValue}
                  onValueChange={setSliderValue}
                  min={0}
                  max={100}
                />
                <FileDropzone
                  label="Product assets"
                  description="Optional scans or listing collateral."
                />
                <InlineMessage tone="success" icon="check">
                  All required fields are complete. This listing is ready to publish.
                </InlineMessage>
              </Fieldset>
            </FormSection>
          }
          inspector={
            <DetailPanel title="Listing Preview">
              <KeyValueList
                items={[
                  { key: "SKU", value: "CS-001" },
                  { key: "Condition", value: "Near Mint" },
                  { key: "Set", value: "Surging Sparks" },
                  { key: "Listed", value: "Mar 1, 2026" }
                ]}
              />
              <StatGrid>
                <Stat label="Expected margin" value="28%" trend="Healthy after shipping rebate" />
                <Stat label="Velocity" value="2.1/day" trend="Trending up" />
              </StatGrid>
              <PageSection title="Publish Health">
                <EmptyState
                  title="No blocking issues"
                  description="Required metadata is present and pricing rules are valid."
                  icon="check"
                />
              </PageSection>
            </DetailPanel>
          }
        />

        <PageSection title="Order Activity">
          <SplitPane
            primary={
              <Timeline
                items={[
                  { title: "Order #1042 shipped", description: "Charizard ex sent via USPS Priority", timestamp: "2 hours ago" },
                  { title: "Pricing rule triggered", description: "Iono adjusted from $13.50 to $12.50", timestamp: "4 hours ago" },
                  { title: "New listing published", description: "Mewtwo VSTAR added to inventory", timestamp: "Yesterday" }
                ]}
              />
            }
            secondary={
              <ActivityList
                items={[
                  { title: "Bulk import completed", description: "42 listings added", actor: "System", timestamp: "1h ago" },
                  { title: "Price override", description: "Manual price set on CS-014", actor: "Todd S.", timestamp: "3h ago" }
                ]}
              />
            }
          />
        </PageSection>

        <AlertDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
          title="Remove selected listings?"
          description="This will delist the selected items from the marketplace. Inventory records are preserved."
          confirmLabel="Remove"
          cancelLabel="Keep listings"
          tone="danger"
          onConfirm={() => {
            setSelectedItems(0);
            setShowDeleteDialog(false);
          }}
        />
      </Page>
    </AdminShell>
  );
}

function RatingDemo() {
  const [value, setValue] = useState(3);
  return (
    <Rating value={value} max={5} size="md" interactive onValueChange={setValue} label="Your rating" />
  );
}

function TagInputDemo() {
  const [tags, setTags] = useState(["Pokemon", "Charizard"]);
  return (
    <TagInput values={tags} onValuesChange={setTags} placeholder="Add a tag..." maxTags={5} />
  );
}

function ColorModeToggleDemo() {
  const [mode, setMode] = useState<ColorMode>("system");
  return <DesignSystemColorModeToggle value={mode} onValueChange={setMode} />;
}

function WizardDemo() {
  const [step, setStep] = useState("details");
  return (
    <Surface>
      <Wizard
        steps={[
          { key: "details", label: "Card Details", content: <Stack gap={3}><TextInput label="Card name" defaultValue="Charizard ex" /><Select label="Set" items={[{ value: "ss", label: "Surging Sparks" }, { value: "sc", label: "Stellar Crown" }]} /></Stack> },
          { key: "condition", label: "Condition & Price", content: <Stack gap={3}><Select label="Condition" items={[{ value: "nm", label: "Near Mint" }, { value: "lp", label: "Light Play" }]} /><CurrencyInput label="Price" defaultValue="29.95" /></Stack> },
          { key: "review", label: "Review", content: <Stack gap={3}><Text>Review your listing before publishing.</Text><KeyValueList items={[{ key: "Card", value: "Charizard ex" }, { key: "Condition", value: "Near Mint" }, { key: "Price", value: "$29.95" }]} /></Stack> }
        ]}
        activeStep={step}
        onStepChange={setStep}
        onComplete={() => {}}
      />
    </Surface>
  );
}

function ComponentsView() {
  return (
    <Page>
      <PageHeader
        eyebrow="Primitives"
        title="Layout, typography, and feedback components"
        description="Atomic building blocks that compose into marketplace and admin surfaces."
      />

      <PageSection title="Icons">
        <Surface>
          <Inline gap={4}>
            {(["search", "cart", "filter", "dashboard", "close", "check", "warning", "chevronDown", "chevronUp", "chevronLeft", "chevronRight", "menu", "spark", "package", "settings", "user", "info", "star", "starHalf", "starEmpty", "copy", "plus", "minus", "edit", "trash", "heart", "heartFilled", "share", "image", "dollar", "truck", "clock", "eye", "eyeOff"] as const).map((name) => (
              <Tooltip key={name} content={name}>
                <Stack gap={1} align="center">
                  <Icon name={name} size="md" tone="accent" />
                  <Caption>{name}</Caption>
                </Stack>
              </Tooltip>
            ))}
          </Inline>
        </Surface>
      </PageSection>

      <PageSection title="Typography">
        <Surface>
          <Stack gap={4}>
            <Heading level={1}>Heading 1 - Display</Heading>
            <Heading level={2}>Heading 2</Heading>
            <Heading level={3}>Heading 3</Heading>
            <Heading level={4}>Heading 4</Heading>
            <Heading level={5}>Heading 5</Heading>
            <Heading level={6}>Heading 6</Heading>
            <Divider />
            <Text>Body text in the default size and weight.</Text>
            <Text size="lg" weight="semibold">Large semibold text for emphasis.</Text>
            <Text size="sm" tone="secondary">Small secondary text for supporting content.</Text>
            <Caption>Caption text for metadata and timestamps.</Caption>
            <Label>Form label</Label>
            <Label muted>Muted label</Label>
            <Text>
              Inline <CodeText>code snippets</CodeText> render in the mono font.
            </Text>
            <LinkText href="#">Accent link with default styling</LinkText>
            <LinkText href="#" tone="subtle" trailingIcon="chevronRight">Subtle link with trailing icon</LinkText>
            <Quote cite="- Design system principles">
              Every component should be composable, accessible, and theme-aware without requiring custom CSS.
            </Quote>
            <List items={["Near Mint (NM)", "Light Play (LP)", "Moderate Play (MP)", "Heavy Play (HP)"]} />
            <List ordered items={["Search for your card", "Compare seller prices", "Add to cart and checkout"]} />
          </Stack>
        </Surface>
      </PageSection>

      <PageSection title="Layout Primitives">
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <Card>
            <Stack gap={3}>
              <Heading level={5}>Box &amp; Inset</Heading>
              <Box padding={4} gap={2}>
                <Text size="sm" tone="secondary">Box with padding=4 and gap=2</Text>
                <Inset padding={3}>
                  <Surface tone="muted">
                    <Text size="sm">Inset content inside a Box</Text>
                  </Surface>
                </Inset>
              </Box>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Center</Heading>
              <Surface tone="muted">
                <Center>
                  <Stack gap={2} align="center">
                    <Icon name="spark" size="lg" tone="accent" />
                    <Text size="sm">Centered content</Text>
                  </Stack>
                </Center>
              </Surface>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Cluster</Heading>
              <Cluster gap={2}>
                <Badge>Tag A</Badge>
                <Badge tone="accent">Tag B</Badge>
                <Badge tone="success">Tag C</Badge>
                <Badge tone="warning">Tag D</Badge>
                <Badge tone="info">Tag E</Badge>
              </Cluster>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Spacer</Heading>
              <Surface tone="muted">
                <Text size="sm">Above spacer</Text>
                <Spacer size={4} />
                <Text size="sm">Below spacer (size=4)</Text>
              </Surface>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Container</Heading>
              <Container width="narrow" paddingX={4}>
                <Surface tone="muted">
                  <Text size="sm">Narrow container (max-w-3xl)</Text>
                </Surface>
              </Container>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>AspectRatio</Heading>
              <AspectRatio ratio={16 / 9}>
                <Surface tone="accent">
                  <Center>
                    <Text tone="inverse" weight="semibold">16:9</Text>
                  </Center>
                </Surface>
              </AspectRatio>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>ScrollArea</Heading>
              <ScrollArea height="sm">
                <Stack gap={2}>
                  {Array.from({ length: 12 }, (_, i) => (
                    <Inset key={i} padding={3}>
                      <Text size="sm">Scrollable item {i + 1}</Text>
                    </Inset>
                  ))}
                </Stack>
              </ScrollArea>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Divider</Heading>
              <Text size="sm">Content above</Text>
              <Divider />
              <Text size="sm">Content below</Text>
              <Inline gap={3} align="center">
                <Text size="sm">Left</Text>
                <Divider orientation="vertical" />
                <Text size="sm">Right</Text>
              </Inline>
            </Stack>
          </Card>
        </Grid>
      </PageSection>

      <PageSection title="Buttons &amp; Navigation">
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <Card>
            <Stack gap={3}>
              <Heading level={5}>Button Variants</Heading>
              <Inline gap={2}>
                <Button>Primary</Button>
                <Button tone="secondary">Secondary</Button>
                <Button tone="ghost">Ghost</Button>
                <Button tone="danger">Danger</Button>
              </Inline>
              <Inline gap={2}>
                <Button size="sm">Small</Button>
                <Button size="md">Medium</Button>
                <Button size="lg">Large</Button>
              </Inline>
              <Inline gap={2}>
                <IconButton label="Search" icon="search" />
                <IconButton label="Settings" icon="settings" tone="secondary" />
                <IconButton label="Close" icon="close" tone="ghost" />
              </Inline>
              <LinkButton href="#" leadingIcon="cart">Link as button</LinkButton>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>NavRail</Heading>
              <NavRail
                items={adminNav}
                activeKey="dashboard"
              />
            </Stack>
          </Card>
        </Grid>
      </PageSection>

      <PageSection title="Feedback &amp; Overlays">
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <Card>
            <Stack gap={3}>
              <Heading level={5}>Badges &amp; Pills</Heading>
              <Inline gap={2}>
                <Badge>Neutral</Badge>
                <Badge tone="accent">Accent</Badge>
                <Badge tone="success">Success</Badge>
                <Badge tone="warning">Warning</Badge>
                <Badge tone="danger">Danger</Badge>
                <Badge tone="info">Info</Badge>
              </Inline>
              <Inline gap={2}>
                <StatusPill tone="success">Active</StatusPill>
                <StatusPill tone="warning">Pending</StatusPill>
                <StatusPill tone="danger">Sold out</StatusPill>
              </Inline>
              <Inline gap={2}>
                <Tag onRemove={() => {}}>Removable</Tag>
                <Tag tone="accent" onRemove={() => {}}>Accent tag</Tag>
              </Inline>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Banners</Heading>
              <Banner tone="success" title="Import complete" description="42 new listings are live." />
              <Banner tone="warning" title="Low stock alert" description="19 SKUs need restocking." />
              <Banner tone="danger" title="Payment failed" description="Update your billing method." />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Loading States</Heading>
              <LoadingSpinner size="sm" label="Fetching listings..." />
              <LoadingSpinner size="md" label="Processing order..." />
              <ProgressBar value={65} tone="accent" />
              <ProgressBar value={30} tone="warning" />
              <Skeleton height="sm" />
              <Skeleton height="md" />
              <Skeleton height="lg" />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Dialogs &amp; Drawers</Heading>
              <Inline gap={2}>
                <Dialog
                  trigger={<Button tone="secondary">Open dialog</Button>}
                  title="Confirm action"
                  description="This demonstrates the Dialog component."
                  footer={<Button>Done</Button>}
                >
                  <Text>Dialog content with any components inside.</Text>
                </Dialog>
                <Drawer
                  trigger={<Button tone="secondary">Open drawer</Button>}
                  title="Listing details"
                  description="Side panel for editing."
                >
                  <Stack gap={3}>
                    <TextInput label="Title" defaultValue="Charizard ex" />
                    <CurrencyInput label="Price" defaultValue="29.95" />
                  </Stack>
                </Drawer>
              </Inline>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Inline Messages &amp; Helpers</Heading>
              <InlineMessage tone="default" icon="info">Informational message for the user.</InlineMessage>
              <InlineMessage tone="success" icon="check">Operation completed successfully.</InlineMessage>
              <InlineMessage tone="danger" icon="warning">Something needs attention.</InlineMessage>
              <Field label="Example field">
                <Text size="sm" tone="secondary">Field wrapper for custom content.</Text>
              </Field>
              <HelperText>Default helper text below a field.</HelperText>
              <HelperText tone="danger">Error helper text.</HelperText>
              <HelperText tone="success">Success helper text.</HelperText>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Empty States</Heading>
              <EmptyState
                title="No results found"
                description="Try adjusting your search or filters."
                icon="search"
                actions={<Button tone="secondary" size="sm">Clear filters</Button>}
              />
              <EmptyStateIllustration title="No chart data yet" />
            </Stack>
          </Card>
        </Grid>
      </PageSection>

      <PageSection title="Data Display">
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <Card>
            <Stack gap={3}>
              <Heading level={5}>Table (simple)</Heading>
              <Table
                columns={["Set", "Cards", "Completion"]}
                rows={[
                  ["Surging Sparks", "195", "82%"],
                  ["Stellar Crown", "175", "64%"],
                  ["Twilight Masquerade", "198", "91%"]
                ]}
                caption="Set completion tracker"
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Avatars</Heading>
              <Inline gap={3}>
                <Avatar name="Todd S." size="sm" />
                <Avatar name="North Side" size="md" />
                <Avatar name="Gem Mint TCG" size="lg" />
              </Inline>
              <Heading level={5}>Thumbnails</Heading>
              <Grid columns={{ base: 3 }} gap={2}>
                <Thumbnail alt="Card front" ratio={3 / 4} icon="spark" />
                <Thumbnail alt="Card back" ratio={3 / 4} icon="package" />
                <Thumbnail alt="Card detail" ratio={3 / 4} icon="search" />
              </Grid>
            </Stack>
          </Card>
        </Grid>
      </PageSection>

      <PageSection title="RecordPage Pattern">
        <RecordPage
          header={
            <PageHeader
              eyebrow="Order #1042"
              title="Charizard ex - 199/165"
              actions={
                <Inline gap={2}>
                  <Button tone="secondary">Edit</Button>
                  <Button tone="danger">Cancel order</Button>
                </Inline>
              }
            />
          }
          summary={
            <Stack gap={4}>
              <KeyValueList
                items={[
                  { key: "Buyer", value: "Todd S." },
                  { key: "Status", value: "Shipped" },
                  { key: "Tracking", value: "9400111899223" },
                  { key: "Total", value: "$34.20" }
                ]}
              />
              <Timeline
                items={[
                  { title: "Delivered", timestamp: "Mar 5, 2026" },
                  { title: "In transit", timestamp: "Mar 3, 2026" },
                  { title: "Shipped", timestamp: "Mar 2, 2026" },
                  { title: "Order placed", timestamp: "Mar 1, 2026" }
                ]}
              />
            </Stack>
          }
          details={
            <DetailPanel title="Order Details">
              <KeyValueList
                items={[
                  { key: "Card", value: "Charizard ex" },
                  { key: "Set", value: "Surging Sparks" },
                  { key: "Condition", value: "Near Mint" },
                  { key: "Seller", value: "North Side Cards" }
                ]}
              />
            </DetailPanel>
          }
        />
      </PageSection>

      <PageSection title="New Components">
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <Card>
            <Stack gap={3}>
              <Heading level={5}>Rating</Heading>
              <Inline gap={4} align="center">
                <Rating value={4} max={5} size="md" label="Product rating" />
                <Rating value={3.5} max={5} size="sm" label="Small rating" />
              </Inline>
              <Text size="sm" tone="secondary">Interactive rating:</Text>
              <RatingDemo />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>CopyButton</Heading>
              <Inline gap={2}>
                <CopyButton value="CS-001-NM" label="Copy SKU" copiedLabel="SKU copied!" />
                <CopyButton value="https://chase-sets.com/listing/199" tone="ghost" />
              </Inline>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Accordion</Heading>
              <Accordion
                type="single"
                collapsible
                items={[
                  { value: "details", trigger: "Card Details", content: <Text size="sm">Charizard ex - 199/165, Surging Sparks. Illustration rare with textured holo.</Text> },
                  { value: "condition", trigger: "Condition Guide", content: <Text size="sm">Near Mint (NM): Minimal edge wear, no scratches on holo surface.</Text> },
                  { value: "shipping", trigger: "Shipping Policy", content: <Text size="sm">Free standard shipping on orders over $25. Cards ship in penny sleeve + toploader.</Text> }
                ]}
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>ImageGallery</Heading>
              <ImageGallery
                images={[
                  { src: "https://placehold.co/300x400/1a1a2e/eaeaea?text=Front", alt: "Card front" },
                  { src: "https://placehold.co/300x400/16213e/eaeaea?text=Back", alt: "Card back" },
                  { src: "https://placehold.co/300x400/0f3460/eaeaea?text=Close-up", alt: "Holo close-up" }
                ]}
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>TagInput</Heading>
              <TagInputDemo />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>PasswordInput</Heading>
              <PasswordInput label="Password" placeholder="Enter password" />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Card with Media Slot</Heading>
              <Card
                media={
                  <AspectRatio ratio={3 / 4}>
                    <div className="flex h-full w-full items-center justify-center bg-accent/10">
                      <Icon name="image" size="lg" tone="accent" />
                    </div>
                  </AspectRatio>
                }
                interactive
              >
                <Stack gap={1}>
                  <Text weight="semibold">Charizard ex - 199/165</Text>
                  <Text size="sm" tone="secondary">Near Mint &middot; Surging Sparks</Text>
                  <PriceDisplay amount={29.95} />
                </Stack>
              </Card>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Enhanced Menu</Heading>
              <Menu
                trigger={<Button tone="secondary">Actions menu</Button>}
                groups={[
                  {
                    label: "Listing",
                    items: [
                      { key: "edit", label: "Edit listing", icon: "edit", onSelect: () => {} },
                      { key: "copy", label: "Copy link", icon: "copy", shortcut: "Ctrl+C", onSelect: () => {} }
                    ]
                  },
                  {
                    label: "Danger zone",
                    items: [
                      { key: "delete", label: "Delete listing", icon: "trash", disabled: false, onSelect: () => {} }
                    ]
                  }
                ]}
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Design System ColorModeToggle</Heading>
              <ColorModeToggleDemo />
            </Stack>
          </Card>
        </Grid>
      </PageSection>

      <PageSection title="Wizard Pattern">
        <WizardDemo />
      </PageSection>

      <VisuallyHidden>
        <Text>This text is visually hidden but available to screen readers.</Text>
      </VisuallyHidden>
    </Page>
  );
}

export function App() {
  const [colorMode, setColorMode] = useState<ColorMode>("system");
  const [showcaseMode, setShowcaseMode] = useState<"marketplace" | "admin" | "components">(
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
            setShowcaseMode(value as "marketplace" | "admin" | "components")
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
            },
            {
              value: "components",
              label: "Components",
              content: null
            }
          ]}
        />
      </Page>
      {showcaseMode === "marketplace" ? (
        <MarketplaceView />
      ) : showcaseMode === "admin" ? (
        <AdminView />
      ) : (
        <ComponentsView />
      )}
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
