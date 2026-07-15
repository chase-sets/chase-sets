import { formatDisplayIdentity, t } from "@chase-sets/localization";
import { Badge, Grid, LinkButton, ListingCard, PageSection, Stack } from "@chase-sets/design-system";
import type {
  DiscoveryItemDetail,
  DiscoveryProductContentItemRef,
  DiscoveryProductContentLine,
  DiscoveryProductContentSelectedOption,
} from "../../../support/client-support/contracts";
import { imageVariantSrcSet } from "../../../support/client-support/assets";
import { buildDiscoveryProductAssetImage } from "../../../support/client-support/product-assets";

type ProductContentsDirection = "contents" | "included_in";

export function ItemDetailProductContents({ data }: { data: DiscoveryItemDetail }) {
  if (data.contents.length === 0 && data.included_in.length === 0) {
    return null;
  }

  return (
    <Stack gap={4}>
      {data.contents.length > 0 ? (
        <ProductContentSection
          title={t("discovery.features.itemDetail.ui.itemDetailPage.contents")}
          lines={data.contents}
          direction="contents"
        />
      ) : null}
      {data.included_in.length > 0 ? (
        <ProductContentSection
          title={t("discovery.features.itemDetail.ui.itemDetailPage.included.in")}
          lines={data.included_in}
          direction="included_in"
        />
      ) : null}
    </Stack>
  );
}

function ProductContentSection({
  title,
  lines,
  direction,
}: {
  title: string;
  lines: readonly DiscoveryProductContentLine[];
  direction: ProductContentsDirection;
}) {
  return (
    <PageSection title={title}>
      <Grid columns={{ base: 1, lg: 2 }} gap={4}>
        {lines.map((line) => (
          <ProductContentLine key={line.line_id} line={line} direction={direction} />
        ))}
      </Grid>
    </PageSection>
  );
}

function ProductContentLine({
  line,
  direction,
}: {
  line: DiscoveryProductContentLine;
  direction: ProductContentsDirection;
}) {
  const target = direction === "contents" ? line.contained_item : line.container_item;
  const selectedOptions = direction === "contents" ? line.contained_selected_options : line.container_selected_options;
  const targetCatalogItemId =
    direction === "contents" ? line.contained_catalog_item_id : line.container_catalog_item_id;
  const lifecycleStatus =
    direction === "contents" ? line.target_lifecycle_status : (line.container_item?.status ?? null);
  const quantityLabel =
    line.quantity === null
      ? t("discovery.features.itemDetail.ui.itemDetailPage.quantity.variable")
      : t("discovery.features.itemDetail.ui.itemDetailPage.quantity.count", { quantity: line.quantity });

  const quantityDetails = line.inclusion_policy_label
    ? t("discovery.features.itemDetail.ui.itemDetailPage.quantity.policy", {
        policy: line.inclusion_policy_label,
        quantity: quantityLabel,
      })
    : quantityLabel;

  return (
    <ProductContentTarget
      target={target}
      targetCatalogItemId={targetCatalogItemId}
      selectedOptions={selectedOptions}
      lifecycleStatus={lifecycleStatus}
      contentTypeLabel={line.content_type_label}
      quantityDetails={quantityDetails}
    />
  );
}

function ProductContentTarget({
  target,
  targetCatalogItemId,
  selectedOptions,
  lifecycleStatus,
  contentTypeLabel,
  quantityDetails,
}: {
  target: DiscoveryProductContentItemRef | null;
  targetCatalogItemId: string | null;
  selectedOptions: readonly DiscoveryProductContentSelectedOption[] | null;
  lifecycleStatus: string | null;
  contentTypeLabel: string;
  quantityDetails: string;
}) {
  const title =
    target?.title ?? targetCatalogItemId ?? t("discovery.features.itemDetail.ui.itemDetailPage.unresolved.content");
  const isActiveTarget = target?.status === "active" && lifecycleStatus !== "archived";
  const href = isActiveTarget && target ? buildItemDetailHref(target.slug, selectedOptions) : null;
  const displayIdentity = formatDisplayIdentity(title, target?.subtitle);
  const productAssetImage = buildDiscoveryProductAssetImage(
    target?.product_asset_sets ?? [],
    "search-card",
    "(min-width: 768px) 164px, 124px",
  );
  const imageSrc =
    productAssetImage?.src ??
    target?.image_urls[0] ??
    (target?.image_fallback?.usage === "permanent" ? target.image_fallback.url : undefined);

  return (
    <ListingCard
      cardLayout="search-result"
      href={href ?? undefined}
      title={title}
      subtitle={target?.subtitle}
      image={productAssetImage ?? undefined}
      imageSrc={imageSrc}
      imageSlot="compact-product"
      imageAlt={displayIdentity}
      imageFallbackSrc={target?.image_fallback?.url}
      imageFallbackAlt={displayIdentity}
      imageFallbackSrcSet={imageVariantSrcSet(target?.image_fallback, "card")}
      imageFallbackSizes="(min-width: 768px) 164px, 124px"
      imageFallbackMode={target?.image_fallback?.usage ?? "permanent"}
      condition={contentTypeLabel}
      valueCue={quantityDetails}
      detailLinkLabel={t("localization.listingCard.view.details.for", { identity: displayIdentity })}
      saveLabel={t("localization.listingCard.save", { identity: displayIdentity })}
      savedLabel={t("localization.listingCard.saved", { identity: displayIdentity })}
      watchingLabel={t("localization.listingCard.watching", { identity: displayIdentity })}
      primaryAction={
        href ? (
          <LinkButton href={href} size="sm">
            {t("discovery.features.itemDetail.ui.similarItems.viewItem")}
          </LinkButton>
        ) : (
          <Badge tone="neutral">{t("discovery.features.itemDetail.ui.itemDetailPage.content.unavailable")}</Badge>
        )
      }
      secondaryAction={false}
    />
  );
}

function buildItemDetailHref(
  slug: string,
  selectedOptions: readonly DiscoveryProductContentSelectedOption[] | null,
): string {
  const searchParams = new URLSearchParams();

  for (const option of selectedOptions ?? []) {
    searchParams.append(`dimension.${option.dimensionId}`, option.optionId);
  }

  const query = searchParams.toString();
  return query ? `/items/${slug}?${query}` : `/items/${slug}`;
}
