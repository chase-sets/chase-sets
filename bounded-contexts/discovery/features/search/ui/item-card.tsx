import {
  Badge,
  ProductCard,
  Text,
  Stack,
  Inline,
} from "@chase-sets/design-system";
import { Link } from "react-router";
import type { DiscoverySearchItem } from "../../../support/client-support/contracts";
import { uniqueDisplayValues } from "../../../support/item-support/unique-display-values";

export function ItemCard({
  item,
  href,
}: {
  item: DiscoverySearchItem;
  href: string;
}) {
  const categoryNames = uniqueDisplayValues(item.category_names);
  const tags = uniqueDisplayValues(item.tags).slice(0, 3);

  return (
    <Link to={href}>
      <ProductCard
        title={item.title}
        subtitle={item.subtitle}
        imageSrc={item.image_urls[0]}
        imageAlt={item.title}
        meta={
          item.market_summary
            ? `${item.market_summary.active_listing_count} listing${
                item.market_summary.active_listing_count === 1 ? "" : "s"
              }`
            : undefined
        }
        price={
          item.market_summary
            ? `From $${item.market_summary.lowest_price_amount ?? "-"}`
            : undefined
        }
      >
        <Stack gap={2}>
          {item.subtitle && (
            <Text tone="secondary" size="sm">{item.subtitle}</Text>
          )}
          {item.blueprint_name && (
            <Text size="sm" tone="secondary">{item.blueprint_name}</Text>
          )}
          {categoryNames.length > 0 && (
            <Inline gap={1}>
              {categoryNames.map((name) => (
                <Badge key={name} tone="accent">{name}</Badge>
              ))}
            </Inline>
          )}
          {tags.length > 0 && (
            <Inline gap={1}>
              {tags.map((tag) => (
                <Badge key={tag} tone="neutral">{tag}</Badge>
              ))}
            </Inline>
          )}
          {item.market_summary ? (
            <Stack gap={1}>
              <Text size="sm" weight="semibold">
                From ${item.market_summary.lowest_price_amount ?? "-"}
              </Text>
              <Text size="sm" tone="secondary">
                {item.market_summary.active_listing_count} listing
                {item.market_summary.active_listing_count === 1 ? "" : "s"} •{" "}
                {item.market_summary.total_visible_quantity} visible
              </Text>
            </Stack>
          ) : null}
        </Stack>
      </ProductCard>
    </Link>
  );
}
