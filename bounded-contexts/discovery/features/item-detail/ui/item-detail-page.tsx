import { useEffect, useState, type ReactNode } from "react";
import {
  Banner,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  CommerceActionBar,
  Container,
  EmptyState,
  Grid,
  Heading,
  Icon,
  ImageGallery,
  Inline,
  KeyValueList,
  LinkButton,
  MarketplaceMetricStrip,
  MarketplaceProductDetailLayout,
  PageSection,
  Reveal,
  Stack,
  Stagger,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
} from "../../../support/client-support/contracts";
import { discoveryAssetUrls } from "../../../support/client-support/assets";
import { uniqueDisplayValues } from "../../../support/item-support/unique-display-values";
import { ProductSelector } from "./product-selector";
import {
  createDiscoveryProductDescriptor,
  getOrderedActiveDimensions,
  isProductSelectionComplete,
  normalizeProductSearchOptionsForSchema,
  summarizeSelections,
} from "../domain/product-resolution";

export type ItemDetailMarketplaceSectionContext = Readonly<{
  itemId: string;
  selectedProductId: string | null;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedProductOptions: readonly { dimensionId: string; optionId: string }[];
  selectedProductSummary: string | null;
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

function matchesSelectedOptions(
  listing: DiscoveryMarketListing,
  selections: Record<string, string>,
) {
  const selectedEntries = Object.entries(selections);

  if (selectedEntries.length === 0) {
    return true;
  }

  return selectedEntries.every(([dimensionId, optionId]) =>
    listing.selected_options.some(
      (entry) => entry.dimensionId === dimensionId && entry.optionId === optionId,
    ),
  );
}

function applyOptionFilter(
  selections: Record<string, string>,
  dimensionId: string,
  optionId: string,
) {
  const nextSelections = { ...selections };

  if (optionId) {
    nextSelections[dimensionId] = optionId;
  } else {
    delete nextSelections[dimensionId];
  }

  return nextSelections;
}

export function ItemDetailPage({
  data,
  notFound = false,
  error = null,
  renderCommerce,
}: {
  data: DiscoveryItemDetail | null;
  notFound?: boolean;
  error?: string | null;
  renderCommerce?: (context: ItemDetailMarketplaceSectionContext) => ReactNode;
}) {
  const [selections, setSelections] = useState<Record<string, string>>(() =>
    data?.product_schema ? normalizeProductSearchOptionsForSchema(data.product_schema, {}) : {},
  );

  useEffect(() => {
    if (!data?.product_schema) {
      setSelections({});
      return;
    }

    setSelections(normalizeProductSearchOptionsForSchema(data.product_schema, {}));
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
  const explicitSelectedOptions = data.product_schema
    ? summarizeSelections(data.product_schema, selections)
    : [];
  const explicitSelectedProductOptions = data.product_schema
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
  const explicitSelectedProductSummary =
    explicitSelectedOptions.length > 0
      ? explicitSelectedOptions.map((selection) => selection.optionLabel).join(" / ")
      : null;
  const hasActiveFilters = Object.keys(selections).length > 0;
  const hasCompleteProductSelection = data.product_schema
    ? isProductSelectionComplete(data.product_schema, selections)
    : true;
  const categories = [
    ...new Map(
      data.categories.map((category) => [category.categoryId, category] as const),
    ).values(),
  ];
  const tags = uniqueDisplayValues(data.tags);
  const visibleListings = data.market_listings.filter((listing) =>
    data.product_schema ? matchesSelectedOptions(listing, selections) : true,
  );
  const singleMatchingListing =
    !hasCompleteProductSelection && visibleListings.length === 1
      ? visibleListings[0]
      : null;
  const selectedProductId = hasCompleteProductSelection
    ? createDiscoveryProductDescriptor({
        catalogItemId: data.catalog_item_id,
        productSchema: data.product_schema,
        selection: explicitSelectedProductOptions,
      }).productId
    : singleMatchingListing?.product_id ?? null;
  const selectedProductOptions =
    hasCompleteProductSelection || !singleMatchingListing
      ? explicitSelectedProductOptions
      : singleMatchingListing.selected_options;
  const selectedProductSummary =
    explicitSelectedProductSummary ?? singleMatchingListing?.product_summary ?? null;
  const selectedMarketSummary = {
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
  };
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
      key: "Last updated",
      value: formatUpdatedAt(data.updated_at),
    },
  ];
  const detailItems = [
    ...data.field_values.map((fieldValue) => ({
      key: fieldValue.fieldName,
      value: formatFieldValue(fieldValue.value),
    })),
    ...metadataItems,
  ];
  const marketplaceContext = {
    itemId: data.catalog_item_id,
    selectedProductId,
    itemTitle: data.title,
    itemSubtitle: data.subtitle,
    selectedProductOptions,
    selectedProductSummary,
    visibleListings,
  } satisfies ItemDetailMarketplaceSectionContext;
  const commerce = renderCommerce?.(marketplaceContext) ?? null;
  const productSummary =
    explicitSelectedProductSummary ?? (singleMatchingListing ? "1 matching listing" : "All listings");
  const marketDetail = hasActiveFilters ? "Filtered listings" : "All listings";

  return (
    <Stagger>
      <Breadcrumbs
        items={[
          { label: "Search", href: "/search" },
          { label: data.title },
        ]}
      />

      <Container width="expanded" paddingX={0}>
        <Reveal preset="lift">
          <MarketplaceProductDetailLayout
            summary={
              <Stack gap={4}>
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
                  <Card variant="feature">
                    <Stack gap={3} id="select-options">
                      <Stack gap={1}>
                        <Text size="sm" weight="semibold">
                          Choose options
                        </Text>
                        <Text size="sm" tone="secondary">
                          {productSummary}
                        </Text>
                      </Stack>
                      <ProductSelector
                        schema={data.product_schema}
                        selections={selections}
                        onSelectionChange={(dimensionId, optionId) =>
                          setSelections((current) =>
                            normalizeProductSearchOptionsForSchema(
                              data.product_schema!,
                              applyOptionFilter(current, dimensionId, optionId),
                            ),
                          )
                        }
                      />
                    </Stack>
                  </Card>
                ) : null}
              </Stack>
            }
            media={
              <ImageGallery
                images={images}
                fallbackImage={{
                  src: discoveryAssetUrls.defaultProductImage,
                  alt: "Pokemon card back",
                }}
                maxHeightClassName="[--gallery-max-height:34rem]"
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
            market={
              <MarketplaceMetricStrip
                items={[
                  {
                    label: "Lowest ask",
                    value: formatMoney(selectedMarketSummary.lowest_price_amount),
                    detail:
                      visibleListings.length > 0
                        ? marketDetail
                        : "No visible supply",
                  },
                  {
                    label: "Active listings",
                    value: selectedMarketSummary.active_listing_count,
                    detail: marketDetail,
                  },
                  {
                    label: "Visible quantity",
                    value: selectedMarketSummary.total_visible_quantity,
                    detail: "Available before checkout matching",
                  },
                  {
                    label: "Recent sale",
                    value: "Unavailable",
                    detail: "Sales history is not published yet",
                  },
                ]}
              />
            }
            commerce={commerce}
            mobileActionBar={
              commerce ? (
                <CommerceActionBar
                  summary={productSummary}
                  primaryAction={
                    <LinkButton
                      href={selectedProductId ? "#buy-box" : "#select-options"}
                      size="sm"
                    >
                      {selectedProductId ? "Add" : "Select"}
                    </LinkButton>
                  }
                  secondaryAction={
                    <LinkButton
                      href={selectedProductId ? "#make-offer" : "#select-options"}
                      tone="secondary"
                      size="sm"
                    >
                      {selectedProductId ? "Offer" : "Filter"}
                    </LinkButton>
                  }
                />
              ) : null
            }
          >
            <Stack gap={6}>
              <Reveal preset="lift">
                <PageSection title="Listings">
                  <Stack gap={3}>
                    <Inline gap={2}>
                      <Text size="sm" tone="secondary">
                        {hasActiveFilters ? (
                          <>
                          {visibleListings.length} of {data.market_listings.length}{" "}
                          listing{data.market_listings.length === 1 ? "" : "s"}
                          </>
                        ) : (
                          <>
                            {visibleListings.length} active listing
                            {visibleListings.length === 1 ? "" : "s"}
                          </>
                        )}
                      </Text>
                      {hasActiveFilters ? (
                        <Button
                          type="button"
                          tone="ghost"
                          size="sm"
                          onClick={() => setSelections({})}
                        >
                          Clear filters
                        </Button>
                      ) : null}
                    </Inline>
                    {visibleListings.length > 0 ? (
                      visibleListings.map((listing) => (
                        <Card key={listing.listing_id}>
                          <Grid columns={{ base: 1, md: 3 }} gap={3}>
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
                                Visible quantity
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
                            ? "No active listings match these filters."
                            : "Sellers have not published inventory for this item yet."
                        }
                        icon="package"
                        actions={
                          <>
                            {selectedProductId ? (
                              <LinkButton href="#make-offer" size="sm">
                                Make offer
                              </LinkButton>
                            ) : (
                              <LinkButton href="#select-options" size="sm">
                                Choose options
                              </LinkButton>
                            )}
                            {hasActiveFilters ? (
                              <Button
                                type="button"
                                tone="secondary"
                                size="sm"
                                onClick={() => setSelections({})}
                              >
                                Clear filters
                              </Button>
                            ) : null}
                          </>
                        }
                      />
                    )}
                  </Stack>
                </PageSection>
              </Reveal>

              {data.description ? (
                <Reveal preset="lift">
                  <PageSection title="Description">
                    <Text>{data.description}</Text>
                  </PageSection>
                </Reveal>
              ) : null}

              {detailItems.length > 0 ? (
                <Reveal preset="lift">
                  <PageSection title="Details">
                    <KeyValueList
                      density="compact"
                      items={detailItems}
                    />
                  </PageSection>
                </Reveal>
              ) : null}
            </Stack>
          </MarketplaceProductDetailLayout>
        </Reveal>
      </Container>
    </Stagger>
  );
}
