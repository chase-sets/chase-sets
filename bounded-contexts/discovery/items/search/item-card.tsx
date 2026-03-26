import {
  Card,
  Icon,
  Text,
  Stack,
  Inline,
} from "@chase-sets/design-system";
import { Link } from "react-router";
import { Badge } from "@chase-sets/design-system";
import type { DiscoverySearchItem } from "../client-support/contracts";

export function ItemCard({
  item,
  href,
}: {
  item: DiscoverySearchItem;
  href: string;
}) {
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
          {item.category_names.length > 0 && (
            <Inline gap={1}>
              {item.category_names.map((name) => (
                <Badge key={name} tone="accent">{name}</Badge>
              ))}
            </Inline>
          )}
          {item.tags.length > 0 && (
            <Inline gap={1}>
              {item.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} tone="neutral">{tag}</Badge>
              ))}
            </Inline>
          )}
        </Stack>
      </Card>
    </Link>
  );
}
