import {
  Card,
  Icon,
  Text,
  Stack,
  Inline,
} from "@chase-sets/design-system";
import { Link } from "react-router";
import { Badge } from "@chase-sets/design-system";
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
    <Link to={href} className="block">
      <Card
        interactive
        media={
          item.image_urls.length > 0 ? (
            <img
              src={item.image_urls[0]}
              alt={item.title}
              className="h-48 w-full object-cover"
            />
          ) : (
            <div className="flex h-48 w-full items-center justify-center bg-background">
              <Icon name="package" size="lg" tone="secondary" />
            </div>
          )
        }
      >
        <Stack gap={2}>
          <Text weight="semibold">{item.title}</Text>
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
      </Card>
    </Link>
  );
}
