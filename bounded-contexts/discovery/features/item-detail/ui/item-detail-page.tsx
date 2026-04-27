import { useEffect, useState, type ReactNode } from "react";
import {
  Breadcrumbs,
  Card,
  Container,
  Grid,
  Heading,
  Icon,
  ImageGallery,
  Inline,
  KeyValueList,
  Banner,
  EmptyState,
  Reveal,
  SplitPane,
  Stack,
  Stagger,
  Surface,
  Text,
  PageSection,
} from "@chase-sets/design-system";
import { Badge } from "@chase-sets/design-system";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
} from "../../../support/client-support/contracts";
import { uniqueDisplayValues } from "../../../support/item-support/unique-display-values";
import { ProductSelector } from "./version-selector";
import {
  createDiscoveryProductDescriptor,
  getOrderedActiveDimensions,
  normalizeSelectedOptionssForSchema,
  summarizeSelections,
} from "../domain/versioning";

export type ItemDetailMarketplaceSectionContext = Readonly<{
  itemId: string;
  selectedProductId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedVersionSelection: readonly { dimensionId: string; optionId: string }[];
  selectedVersionSummary: string | null;
  visibleListings: readonly DiscoveryMarketListing[];
}>;

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  return JSON.stringify(value);
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  }).format(date)} UTC`;
}

function formatMoney(value: string | null): string {
  return value ? `$${value}` : "Unavailable";
}

function matchesSelectedVersion(
  listing: DiscoveryMarketListing,
  selections: Record<string, string>,
) {
  return listing.selected_options.every(
    (entry) => selections[entry.dimensionId] === entry.optionId,
  );
}

export function ItemDetailPage({
  data,
  notFound = false,
  error = null,
  renderAfterListings,
}: {
  data: DiscoveryItemDetail | null;
  notFound?: boolean;
  error?: string | null;
  renderAfterListings?: (context: ItemDetailMarketplaceSectionContext) => ReactNode;
}) {
  const [selections, setSelections] = useState<Record<string, string>>(() =>
    data?.product_schema ? normalizeSelectedOptionssForSchema(data.product_schema, {}) : {},
  );

  useEffect(() => {
    if (!data?.product_schema) {
      setSelections({});
      return;
    }

    setSelections(normalizeSelectedOptionssForSchema(data.product_schema, {}));
  }, [data]);

  if (error) {
    return <Banner tone="danger" title="Error" description={error} />;
  }

  if (!data) {
    return (
      <Banner
        tone="danger"
        title={notFound ? "Not found" : "Error"}
        description={
          notFound
            ? "This item could not be found."
            : "This item is not available right now."
        }
      />
    );
  }

  const images = data.image_urls.map((url, index) => ({
    src: url,
    alt: `${data.title} image ${index + 1}`,
  }));
  const selectedVersion = data.product_schema
    ? summarizeSelections(data.product_schema, selections)
    : [];
  const selectedVersionSelection = data.product_schema
    ? getOrderedActiveDimensions(data.product_schema, selections)
        .map((dimension) => {
          const optionId = selections[dimension.dimensionId];

          if (!optionId) {
            return null;
          }

          return {
            dimensionId: dimension.dimensionId,
            optionId,
          };
        })
        .filter(
          (
            selection,
          ): selection is { dimensionId: string; optionId: string } => selection !== null,
        )
    : [];
  const selectedVersionSummary =
    selectedVersion.length > 0
      ? selectedVersion
          .map((selection) => `${selection.dimensionName}: ${selection.optionLabel}`)
          .join(" | ")
      : null;
  const selectedProductId = createDiscoveryProductDescriptor({
    catalogItemId: data.catalog_item_id,
    productSchema: data.product_schema,
    selection: selectedVersionSelection,
  }).productId;
  const categories = [...new Map(
    data.categories.map((category) => [category.categoryId, category] as const),
  ).values()];
  const tags = uniqueDisplayValues(data.tags);
  const visibleListings = data.market_listings.filter((listing) =>
    data.product_schema ? matchesSelectedVersion(listing, selections) : true,
  );
  const selectedMarketSummary =
    visibleListings.length > 0
      ? {
          lowest_price_amount: visibleListings.reduce<string | null>((lowest, listing) => {
            if (lowest === null) {
              return listing.price_amount;
            }
            return Number.parseFloat(listing.price_amount) < Number.parseFloat(lowest)
              ? listing.price_amount
              : lowest;
          }, null),
          active_listing_count: visibleListings.length,
          total_visible_quantity: visibleListings.reduce(
            (sum, listing) => sum + listing.visible_quantity,
            0,
          ),
        }
      : null;
  const metadataItems = [
    ...(tags.length > 0
      ? [
          {
            key: "Tags",
            value: (
              <Inline gap={1}>
                {tags.map((tag) => (
                  <Badge key={tag} tone="neutral">
                    {tag}
                  </Badge>
                ))}
              </Inline>
            ),
          },
        ]
      : []),
    {
      key: "Last Updated",
      value: formatUpdatedAt(data.updated_at),
    },
  ];

  return (
    <Stagger>
      <Breadcrumbs
        items={[
          { label: "Search", href: "/search" },
          { label: data.title },
        ]}
      />

      <Container width="wide" paddingX={0}>
        <Reveal preset="lift">
          <SplitPane
            secondarySticky
            secondaryWidth="detail"
            primary={
              <Stack gap={4}>
                <Surface elevated>
                  <Stack gap={5}>
                    <Stack gap={3}>
                      {data.blueprint ? (
                        <Text size="sm" weight="semibold" tone="accent">
                          {data.blueprint.name}
                        </Text>
                      ) : null}

                      <Stack gap={2}>
                        <Heading level={1}>{data.title}</Heading>
                        {data.subtitle ? (
                          <Text size="lg" tone="secondary">
                            {data.subtitle}
                          </Text>
                        ) : null}
                      </Stack>

                      {categories.length > 0 ? (
                        <Inline gap={2}>
                          {categories.map((category) => (
                            <Badge key={category.categoryId} tone="accent">
                              {category.name}
                            </Badge>
                          ))}
                        </Inline>
                      ) : null}
                    </Stack>

                    {data.product_schema && data.product_schema.dimensions.length > 0 ? (
                      <Stack gap={3}>
                        <Text size="sm" weight="semibold">
                          Choose Product
                        </Text>
                        <ProductSelector
                          schema={data.product_schema}
                          selections={selections}
                          onSelectionChange={(dimensionId, optionId) =>
                            setSelections((current) =>
                              normalizeSelectedOptionssForSchema(data.product_schema!, {
                                ...current,
                                [dimensionId]: optionId,
                              }),
                            )
                          }
                        />
                      </Stack>
                    ) : null}

                    <Grid columns={{ base: 1, xl: 2 }} gap={4}>
                      {selectedVersion.length > 0 ? (
                        <Stack gap={2}>
                          <Text size="sm" weight="semibold">
                            Selected Product
                          </Text>
                          <KeyValueList
                            items={selectedVersion.map((selection) => ({
                              key: selection.dimensionName,
                              value: selection.optionLabel,
                            }))}
                          />
                        </Stack>
                      ) : null}

                      {metadataItems.length > 0 ? (
                        <Stack gap={2}>
                          <Text size="sm" weight="semibold">
                            Item Facts
                          </Text>
                          <KeyValueList items={metadataItems} />
                        </Stack>
                      ) : null}
                    </Grid>

                    {selectedMarketSummary ? (
                      <Grid columns={{ base: 1, md: 3 }} gap={3}>
                        <Card>
                          <Stack gap={1}>
                            <Text size="sm" tone="secondary">
                              Lowest Price
                            </Text>
                            <Text weight="semibold">
                              {formatMoney(selectedMarketSummary.lowest_price_amount)}
                            </Text>
                          </Stack>
                        </Card>
                        <Card>
                          <Stack gap={1}>
                            <Text size="sm" tone="secondary">
                              Active Listings
                            </Text>
                            <Text weight="semibold">
                              {selectedMarketSummary.active_listing_count}
                            </Text>
                          </Stack>
                        </Card>
                        <Card>
                          <Stack gap={1}>
                            <Text size="sm" tone="secondary">
                              Visible Quantity
                            </Text>
                            <Text weight="semibold">
                              {selectedMarketSummary.total_visible_quantity}
                            </Text>
                          </Stack>
                        </Card>
                      </Grid>
                    ) : null}
                  </Stack>
                </Surface>
              </Stack>
            }
            secondary={
              <ImageGallery
                images={images}
                emptyState={
                  <Stack gap={3} align="center">
                    <Surface tone="muted" padding={4}>
                      <Icon name="image" size="lg" tone="secondary" />
                    </Surface>
                    <Stack gap={1} align="center">
                      <Text weight="semibold">Image coming soon</Text>
                      <Text size="sm" tone="secondary">
                        Catalog imagery has not been added yet.
                      </Text>
                    </Stack>
                  </Stack>
                }
              />
            }
          />
        </Reveal>
      </Container>

      <Container width="content" paddingX={0}>
        <Stack gap={6}>
          {data.description ? (
            <Reveal preset="lift">
              <PageSection title="Description">
                <Surface>
                  <Text>{data.description}</Text>
                </Surface>
              </PageSection>
            </Reveal>
          ) : null}

          <Reveal preset="lift">
            <PageSection title="Listings">
              <Stack gap={3}>
                {visibleListings.length > 0 ? (
                  visibleListings.map((listing) => (
                    <Card key={listing.listing_id}>
                      <Grid columns={{ base: 1, md: 4 }} gap={3}>
                        <Stack gap={1}>
                          <Text weight="semibold">
                            {formatMoney(listing.price_amount)}
                          </Text>
                          <Text size="sm" tone="secondary">
                            {listing.seller_display_name ?? "Seller"}
                          </Text>
                        </Stack>
                        <Stack gap={1}>
                          <Text size="sm" tone="secondary">
                            Visible Quantity
                          </Text>
                          <Text>{listing.visible_quantity}</Text>
                        </Stack>
                        <Stack gap={1}>
                          <Text size="sm" tone="secondary">
                            Product
                          </Text>
                          <Text>{listing.product_summary ?? "Standard"}</Text>
                        </Stack>
                      </Grid>
                    </Card>
                  ))
                ) : (
                  <EmptyState
                    title="No active listings"
                    description={
                      data.market_listings.length > 0
                        ? "No active listings match the selected product."
                        : "Sellers have not published inventory for this item yet."
                    }
                    icon="package"
                  />
                )}
              </Stack>
            </PageSection>
          </Reveal>

          {renderAfterListings
            ? renderAfterListings({
                itemId: data.catalog_item_id,
                selectedProductId,
                itemTitle: data.title,
                itemSubtitle: data.subtitle,
                selectedVersionSelection,
                selectedVersionSummary,
                visibleListings,
              })
            : null}

          {data.field_values.length > 0 ? (
            <Reveal preset="lift">
              <PageSection title="Details">
                <KeyValueList
                  items={data.field_values.map((fieldValue) => ({
                    key: fieldValue.fieldName,
                    value: formatFieldValue(fieldValue.value),
                  }))}
                />
              </PageSection>
            </Reveal>
          ) : null}
        </Stack>
      </Container>
    </Stagger>
  );
}
