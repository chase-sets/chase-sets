import { t } from "@chase-sets/localization";
import { Badge, Card, KeyValueList, LinkText, Stack, Text } from "@chase-sets/design-system";
import type {
  DiscoveryItemDetail,
  DiscoveryProductContentItemRef,
  DiscoveryProductContentLine,
  DiscoveryProductContentSelectedOption,
} from "../../../support/client-support/contracts";

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
    <Card variant="feature">
      <Card.Header>
        <Card.Title>{title}</Card.Title>
      </Card.Header>
      <Card.Body>
        <KeyValueList
          density="compact"
          items={lines.map((line) => ({
            key: line.content_type_label,
            value: <ProductContentLine line={line} direction={direction} />,
          }))}
        />
      </Card.Body>
    </Card>
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

  return (
    <Stack gap={1}>
      <Stack gap={1}>
        <ProductContentTarget
          target={target}
          targetCatalogItemId={targetCatalogItemId}
          selectedOptions={selectedOptions}
          lifecycleStatus={lifecycleStatus}
        />
        <Text size="xs" tone="secondary">
          {line.inclusion_policy_label
            ? t("discovery.features.itemDetail.ui.itemDetailPage.quantity.policy", {
                policy: line.inclusion_policy_label,
                quantity: quantityLabel,
              })
            : quantityLabel}
        </Text>
      </Stack>
    </Stack>
  );
}

function ProductContentTarget({
  target,
  targetCatalogItemId,
  selectedOptions,
  lifecycleStatus,
}: {
  target: DiscoveryProductContentItemRef | null;
  targetCatalogItemId: string | null;
  selectedOptions: readonly DiscoveryProductContentSelectedOption[] | null;
  lifecycleStatus: string | null;
}) {
  const title =
    target?.title ?? targetCatalogItemId ?? t("discovery.features.itemDetail.ui.itemDetailPage.unresolved.content");
  const subtitle = target?.subtitle;
  const isActiveTarget = target?.status === "active" && lifecycleStatus !== "archived";
  const href = isActiveTarget && target ? buildItemDetailHref(target.slug, selectedOptions) : null;

  return (
    <Stack gap={1}>
      {href ? (
        <LinkText href={href}>{title}</LinkText>
      ) : (
        <Text element="span" weight="medium">
          {title}
        </Text>
      )}
      <Stack gap={1}>
        {subtitle ? (
          <Text size="xs" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
        {!href ? (
          <Badge tone="neutral">{t("discovery.features.itemDetail.ui.itemDetailPage.content.unavailable")}</Badge>
        ) : null}
      </Stack>
    </Stack>
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
