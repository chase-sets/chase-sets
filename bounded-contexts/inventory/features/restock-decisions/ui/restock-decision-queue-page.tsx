import { formatDateTime, t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Card,
  Form,
  HiddenInput,
  Inline,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  Textarea,
} from "@chase-sets/design-system";
import type { InventoryRestockDecision } from "../api/contracts";

function itemLabel(decision: InventoryRestockDecision) {
  return decision.item_title ?? decision.item_id;
}

function sourceLabel(source: InventoryRestockDecision["source"]) {
  switch (source) {
    case "order-cancelled-after-dispatch":
      return t("inventory.features.restockDecisions.ui.queue.source.cancelled.after.dispatch");
    case "shipment-returned":
      return t("inventory.features.restockDecisions.ui.queue.source.shipment.returned");
    default:
      return source;
  }
}

export function RestockDecisionQueuePage({
  decisions,
  errorMessage,
}: {
  decisions: readonly InventoryRestockDecision[];
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("inventory.features.restockDecisions.ui.queue.seller")}
        title={t("inventory.features.restockDecisions.ui.queue.title")}
        description={t("inventory.features.restockDecisions.ui.queue.description")}
        actions={
          <LinkButton href="/account/inventory" tone="secondary">
            {t("inventory.features.restockDecisions.ui.queue.back.to.inventory")}
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card elevation="tinted" data-elevation-role="furniture">
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("inventory.features.restockDecisions.ui.queue.pending")}>
        <Stack gap={4}>
          {decisions.length === 0 ? (
            <Card elevation="tinted" data-elevation-role="furniture">
              <Text>{t("inventory.features.restockDecisions.ui.queue.empty")}</Text>
            </Card>
          ) : (
            decisions.map((decision) => (
              <Card key={decision.decision_id} elevation="elevated" data-elevation-role="entity">
                <Stack gap={3}>
                  <Inline>
                    <Badge tone="warning">{sourceLabel(decision.source)}</Badge>
                    <Badge tone="neutral">
                      {t("inventory.features.restockDecisions.ui.queue.quantity", { count: decision.quantity })}
                    </Badge>
                  </Inline>
                  <Stack gap={1}>
                    <Text weight="semibold">{itemLabel(decision)}</Text>
                    {decision.item_subtitle ? <Text tone="secondary">{decision.item_subtitle}</Text> : null}
                    <Text tone="secondary" size="sm">
                      {formatDateTime(decision.pending_at)}
                    </Text>
                  </Stack>
                  <Inline>
                    <LinkButton href={`/account/sales/${decision.order_id}`} tone="secondary" size="sm">
                      {t("inventory.features.restockDecisions.ui.queue.view.order", {
                        orderId: decision.order_id,
                      })}
                    </LinkButton>
                    <LinkButton href={`/account/inventory/items/${decision.item_id}`} tone="secondary" size="sm">
                      {t("inventory.features.restockDecisions.ui.queue.view.ledger")}
                    </LinkButton>
                  </Inline>
                  {decision.return_reason ? <Text>{decision.return_reason}</Text> : null}
                  <Inline>
                    <Form spacing="none" method="post">
                      <HiddenInput type="hidden" name="intent" value="restock" />
                      <HiddenInput type="hidden" name="decisionId" value={decision.decision_id} />
                      <Button type="submit">{t("inventory.features.restockDecisions.ui.queue.restock")}</Button>
                    </Form>
                    <Form spacing="none" method="post">
                      <Stack gap={2}>
                        <HiddenInput type="hidden" name="intent" value="write-off" />
                        <HiddenInput type="hidden" name="decisionId" value={decision.decision_id} />
                        <Textarea
                          label={t("inventory.features.restockDecisions.ui.queue.damage.note")}
                          name="damageNote"
                          rows={2}
                        />
                        <Button type="submit" tone="secondary">
                          {t("inventory.features.restockDecisions.ui.queue.write.off")}
                        </Button>
                      </Stack>
                    </Form>
                  </Inline>
                </Stack>
              </Card>
            ))
          )}
        </Stack>
      </PageSection>
    </Page>
  );
}
