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
import { t } from "@chase-sets/localization";
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
          <Heading level={1}>
            {t("discovery.features.productAlerts.ui.productAlertListPage.product.alerts")}
          </Heading>
          <Text tone="secondary">
            {t("discovery.features.productAlerts.ui.productAlertListPage.watch.selected.products")}
          </Text>
        </Stack>

        <PageSection title={t("discovery.features.productAlerts.ui.productAlertListPage.active.watches")}>
          {alerts.length === 0 ? (
            <Card>
              <Stack gap={3}>
                <Text weight="semibold">
                  {t("discovery.features.productAlerts.ui.productAlertListPage.no.product.alerts.yet")}
                </Text>
                <Text tone="secondary">
                  {t("discovery.features.productAlerts.ui.productAlertListPage.choose.product.options")}
                </Text>
                <Inline>
                  <LinkButton href="/search" tone="secondary">
                    {t("discovery.features.productAlerts.ui.productAlertListPage.browse.products")}
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
  const sideLabel =
    alert.market_side === "listing"
      ? t("discovery.features.productAlerts.ui.productAlertListPage.listings")
      : t("discovery.features.productAlerts.ui.productAlertListPage.offers");
  const thresholdLabel =
    alert.threshold_amount === null
      ? t("discovery.features.productAlerts.ui.productAlertListPage.all.new.matches")
      : alert.market_side === "listing"
        ? t("discovery.features.productAlerts.ui.productAlertListPage.at.or.below", {
            amount: `$${alert.threshold_amount}`,
          })
        : t("discovery.features.productAlerts.ui.productAlertListPage.at.or.above", {
            amount: `$${alert.threshold_amount}`,
          });
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
          {t("discovery.features.productAlerts.ui.productAlertListPage.product.id", {
            productId: alert.product_id,
          })}
        </Text>

        <Inline gap={2}>
          <form method="post">
            <input type="hidden" name="intent" value={nextAction} />
            <input type="hidden" name="alertId" value={alert.alert_id} />
            <Button type="submit" tone="secondary" size="sm">
              {alert.status === "paused"
                ? t("discovery.features.productAlerts.ui.productAlertListPage.resume")
                : t("discovery.features.productAlerts.ui.productAlertListPage.pause")}
            </Button>
          </form>
          <form method="post">
            <input type="hidden" name="intent" value="delete" />
            <input type="hidden" name="alertId" value={alert.alert_id} />
            <Button type="submit" tone="ghost" size="sm">
              {t("discovery.features.productAlerts.ui.productAlertListPage.delete")}
            </Button>
          </form>
          <LinkButton
            href={`/items/${encodeURIComponent(alert.catalog_catalog_item_id)}`}
            tone="ghost"
            size="sm"
          >
            {t("discovery.features.productAlerts.ui.productAlertListPage.view.product")}
          </LinkButton>
        </Inline>
      </Stack>
    </Card>
  );
}
