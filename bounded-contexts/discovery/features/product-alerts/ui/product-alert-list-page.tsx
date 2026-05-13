import {
  Badge,
  Button,
  Card,
  Container,
  Grid,
  Heading,
  Inline,
  LinkButton,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { ProductAlertPageRow } from "../read-model/queries";

export function ProductAlertListPage({
  alerts,
}: {
  alerts: readonly ProductAlertPageRow[];
}) {
  return (
    <Container width="wide">
      <Stack gap={6}>
        <Stack gap={2}>
          <Heading level={1}>Product Alerts</Heading>
          <Text tone="secondary">
            Watch selected products for new listings or offer demand that meets your price.
          </Text>
        </Stack>

        <PageSection title="Active watches">
          {alerts.length === 0 ? (
            <Card>
              <Stack gap={3}>
                <Text weight="semibold">No Product Alerts yet</Text>
                <Text tone="secondary">
                  Choose product options from an item detail page, then create an alert for listings or offers.
                </Text>
                <Inline>
                  <LinkButton href="/search" tone="secondary">
                    Browse products
                  </LinkButton>
                </Inline>
              </Stack>
            </Card>
          ) : (
            <Grid columns={{ base: 1, lg: 2 }} gap={4}>
              {alerts.map((alert) => (
                <ProductAlertCard key={alert.alert_id} alert={alert} />
              ))}
            </Grid>
          )}
        </PageSection>
      </Stack>
    </Container>
  );
}

function ProductAlertCard({ alert }: { alert: ProductAlertPageRow }) {
  const sideLabel = alert.market_side === "listing" ? "Listings" : "Offers";
  const thresholdLabel =
    alert.threshold_amount === null
      ? "All new matches"
      : alert.market_side === "listing"
        ? `At or below $${alert.threshold_amount}`
        : `At or above $${alert.threshold_amount}`;
  const nextAction = alert.status === "paused" ? "resume" : "pause";

  return (
    <Card>
      <Stack gap={4}>
        <Inline align="start" gap={3}>
          <Stack gap={1}>
            <Text weight="semibold">
              {alert.product_summary ?? alert.product_id}
            </Text>
            <Text size="sm" tone="secondary">
              {sideLabel} · {thresholdLabel}
            </Text>
          </Stack>
          <Badge tone={alert.status === "active" ? "success" : "neutral"}>
            {alert.status}
          </Badge>
        </Inline>

        <Text size="sm" tone="secondary">
          Product {alert.product_id}
        </Text>

        <Inline gap={2}>
          <form method="post">
            <input type="hidden" name="intent" value={nextAction} />
            <input type="hidden" name="alertId" value={alert.alert_id} />
            <Button type="submit" tone="secondary" size="sm">
              {alert.status === "paused" ? "Resume" : "Pause"}
            </Button>
          </form>
          <form method="post">
            <input type="hidden" name="intent" value="delete" />
            <input type="hidden" name="alertId" value={alert.alert_id} />
            <Button type="submit" tone="ghost" size="sm">
              Delete
            </Button>
          </form>
          <LinkButton
            href={`/items/${encodeURIComponent(alert.catalog_catalog_item_id)}`}
            tone="ghost"
            size="sm"
          >
            View product
          </LinkButton>
        </Inline>
      </Stack>
    </Card>
  );
}
