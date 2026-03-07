import { useState } from "react";
import {
  ActivityList,
  AdminShell,
  AlertDialog,
  Banner,
  BulkActionBar,
  Button,
  Caption,
  Card,
  Checkbox,
  CheckboxGroup,
  CodeText,
  ConditionBadge,
  CurrencyInput,
  DataTable,
  DetailPanel,
  EmptyState,
  Fieldset,
  FileDropzone,
  FormSection,
  Grid,
  Inline,
  InlineMessage,
  InspectorLayout,
  KeyValueList,
  LoadingSpinner,
  Menu,
  MetricStrip,
  NumberInput,
  Page,
  PageHeader,
  PageSection,
  PriceDisplay,
  ProgressBar,
  SelectionToolbar,
  SellerBadge,
  Skeleton,
  Slider,
  Stack,
  Stat,
  StatGrid,
  Surface,
  Switch,
  Text,
  TextInput,
  Textarea,
  Timeline
} from "@chase-sets/design-system";
import { adminNav, inventoryRows } from "../fixtures";

export function AdminView() {
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
            trigger={<Button tone="secondary" leadingIcon="menu">Actions</Button>}
            items={[
              {
                key: "export",
                label: "Export inventory",
                description: "Download as CSV"
              },
              {
                key: "import",
                label: "Bulk import",
                description: "Upload listing spreadsheet"
              },
              {
                key: "archive",
                label: "Archive sold",
                description: "Move zero-stock to archive",
                destructive: true
              }
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
          actions={
            <Button tone="secondary" size="sm">
              View details
            </Button>
          }
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
          {selectedItems > 0 ? (
            <BulkActionBar
              count={selectedItems}
              actions={
                <>
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => setSelectedItems(0)}
                  >
                    Deselect
                  </Button>
                  <Button
                    tone="danger"
                    size="sm"
                    onClick={() => setShowDeleteDialog(true)}
                  >
                    Remove listings
                  </Button>
                </>
              }
            />
          ) : null}
          <SelectionToolbar
            count={3}
            actions={
              <>
                <Button tone="secondary" size="sm">
                  Reprice
                </Button>
                <Button tone="secondary" size="sm">
                  Export
                </Button>
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
              <Fieldset
                legend="Core listing data"
                description="Market-ready metadata with no custom CSS."
              >
                <TextInput
                  label="Listing title"
                  defaultValue="Charizard ex - 199/165"
                />
                <CurrencyInput label="Unit price" defaultValue="29.95" />
                <NumberInput label="Quantity" defaultValue="14" />
                <Textarea
                  label="Seller notes"
                  placeholder="Condition details, special offers..."
                  rows={3}
                />
              </Fieldset>
              <Fieldset
                legend="Categorization"
                description="Help buyers find this listing."
              >
                <CheckboxGroup
                  label="Listing tags"
                  items={[
                    {
                      value: "chase",
                      label: "Chase card",
                      description: "High-demand pull"
                    },
                    { value: "alt-art", label: "Alternate art" },
                    { value: "promo", label: "Promo / event exclusive" }
                  ]}
                  values={["chase"]}
                />
              </Fieldset>
              <Fieldset
                legend="Operational settings"
                description="Bulk-safe admin controls."
              >
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
                  All required fields are complete. This listing is ready to
                  publish.
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
                <Stat
                  label="Expected margin"
                  value="28%"
                  trend="Healthy after shipping rebate"
                />
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
          <Grid columns={{ base: 1, lg: 2 }} gap={4}>
            <Surface>
              <Timeline
                items={[
                  {
                    title: "Order #1042 shipped",
                    description: "Charizard ex sent via USPS Priority",
                    timestamp: "2 hours ago"
                  },
                  {
                    title: "Pricing rule triggered",
                    description: "Iono adjusted from $13.50 to $12.50",
                    timestamp: "4 hours ago"
                  },
                  {
                    title: "New listing published",
                    description: "Mewtwo VSTAR added to inventory",
                    timestamp: "Yesterday"
                  }
                ]}
              />
            </Surface>
            <Surface>
              <ActivityList
                items={[
                  {
                    title: "Bulk import completed",
                    description: "42 listings added",
                    actor: "System",
                    timestamp: "1h ago"
                  },
                  {
                    title: "Price override",
                    description: "Manual price set on CS-014",
                    actor: "Todd S.",
                    timestamp: "3h ago"
                  }
                ]}
              />
            </Surface>
          </Grid>
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
