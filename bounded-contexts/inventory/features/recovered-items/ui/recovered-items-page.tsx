import { formatDateTime, formatMoney, t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Card,
  DataTable,
  Form,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
  type Tone,
} from "@chase-sets/design-system";
import type { InventoryRecoveredItemRow } from "../read-model/queries";

export type RecoveredItemMetrics = Readonly<{
  total_count: number;
  unidentified_count: number;
  quarantined_count: number;
  sellable_count: number;
  terminal_count: number;
  recovered_count: number;
  recovery_rate: number;
  average_age_hours: number;
  gross_value: string;
  disposition_cost: string;
  net_recovered_value: string;
}>;

function statusTone(status: string): Tone {
  if (status === "sellable" || status === "transferred") return "success";
  if (status === "disposed" || status === "merged") return "neutral";
  if (status === "authenticity-review" || status === "awaiting-identification") return "warning";
  return "accent";
}

export function RecoveredItemsPage({
  items,
  metrics,
  lastAction,
}: {
  items: readonly InventoryRecoveredItemRow[];
  metrics: RecoveredItemMetrics;
  lastAction?: Readonly<{ recoveredItemId?: string; status?: string; error?: string }> | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("inventory.features.recoveredItems.ui.page.inventory")}
        title={t("inventory.features.recoveredItems.ui.page.title")}
        description={t("inventory.features.recoveredItems.ui.page.description")}
      />

      <PageSection title={t("inventory.features.recoveredItems.ui.page.metrics")}>
        <DataTable
          rows={[
            {
              id: "unidentified",
              label: t("inventory.features.recoveredItems.ui.page.unidentified"),
              value: metrics.unidentified_count,
            },
            {
              id: "quarantined",
              label: t("inventory.features.recoveredItems.ui.page.quarantined"),
              value: metrics.quarantined_count,
            },
            {
              id: "sellable",
              label: t("inventory.features.recoveredItems.ui.page.sellable"),
              value: metrics.sellable_count,
            },
            {
              id: "terminal",
              label: t("inventory.features.recoveredItems.ui.page.terminal"),
              value: metrics.terminal_count,
            },
            {
              id: "rate",
              label: t("inventory.features.recoveredItems.ui.page.recovery.rate"),
              value: `${Math.round(metrics.recovery_rate * 100)}%`,
            },
            {
              id: "age",
              label: t("inventory.features.recoveredItems.ui.page.average.age"),
              value: Math.round(metrics.average_age_hours),
            },
          ]}
          getRowId={(row) => row.id}
          columns={[
            { key: "label", header: t("inventory.features.recoveredItems.ui.page.signal"), cell: (row) => row.label },
            {
              key: "value",
              header: t("inventory.features.recoveredItems.ui.page.value"),
              cell: (row) => (
                <Badge tone={typeof row.value === "number" && row.value > 0 ? "warning" : "success"}>{row.value}</Badge>
              ),
            },
          ]}
        />
        <Text tone="secondary">
          {t("inventory.features.recoveredItems.ui.page.recovery.summary", {
            gross: formatMoney(metrics.gross_value, "USD"),
            cost: formatMoney(metrics.disposition_cost, "USD"),
            net: formatMoney(metrics.net_recovered_value, "USD"),
          })}
        </Text>
      </PageSection>

      <PageSection title={t("inventory.features.recoveredItems.ui.page.queue")}>
        <DataTable
          rows={[...items]}
          getRowId={(row) => row.recovered_item_id}
          columns={[
            {
              key: "status",
              header: t("inventory.features.recoveredItems.ui.page.status"),
              cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: "custody",
              header: t("inventory.features.recoveredItems.ui.page.custody"),
              cell: (row) => row.custody_identifier,
            },
            {
              key: "identity",
              header: t("inventory.features.recoveredItems.ui.page.identity"),
              cell: (row) => row.catalog_item_id ?? t("inventory.features.recoveredItems.ui.page.unidentified"),
            },
            {
              key: "condition",
              header: t("inventory.features.recoveredItems.ui.page.condition"),
              cell: (row) => row.condition_grade ?? t("inventory.features.recoveredItems.ui.page.pending"),
            },
            {
              key: "disposition",
              header: t("inventory.features.recoveredItems.ui.page.disposition"),
              cell: (row) => row.disposition ?? t("inventory.features.recoveredItems.ui.page.pending"),
            },
            {
              key: "age",
              header: t("inventory.features.recoveredItems.ui.page.received"),
              cell: (row) => formatDateTime(row.received_at),
            },
            {
              key: "evidence",
              header: t("inventory.features.recoveredItems.ui.page.evidence"),
              cell: (row) =>
                t("inventory.features.recoveredItems.ui.page.evidence.count", {
                  count: row.evidence_references.length,
                }),
            },
          ]}
          emptyTitle={t("inventory.features.recoveredItems.ui.page.empty.title")}
          emptyDescription={t("inventory.features.recoveredItems.ui.page.empty.description")}
        />
      </PageSection>

      <PageSection title={t("inventory.features.recoveredItems.ui.page.action.title")}>
        <Card elevation="tinted" data-elevation-role="furniture">
          <Stack gap={3}>
            <Text tone="secondary">{t("inventory.features.recoveredItems.ui.page.action.description")}</Text>
            {lastAction?.error ? <Badge tone="danger">{lastAction.error}</Badge> : null}
            {lastAction?.recoveredItemId ? (
              <Badge tone="success">
                {t("inventory.features.recoveredItems.ui.page.action.completed", {
                  id: lastAction.recoveredItemId,
                  status: lastAction.status ?? t("inventory.features.recoveredItems.ui.page.action.updated"),
                })}
              </Badge>
            ) : null}
            <Form method="post" spacing="md">
              <TextInput
                label={t("inventory.features.recoveredItems.ui.page.item.id")}
                name="recoveredItemId"
                required
              />
              <NativeSelect
                label={t("inventory.features.recoveredItems.ui.page.action")}
                name="intent"
                items={[
                  { value: "identify", label: t("inventory.features.recoveredItems.ui.page.action.identify") },
                  { value: "inspect", label: t("inventory.features.recoveredItems.ui.page.action.inspect") },
                  {
                    value: "require-authenticity-review",
                    label: t("inventory.features.recoveredItems.ui.page.action.require.authenticity"),
                  },
                  {
                    value: "complete-authenticity-review",
                    label: t("inventory.features.recoveredItems.ui.page.action.complete.authenticity"),
                  },
                  { value: "record-authority", label: t("inventory.features.recoveredItems.ui.page.action.authority") },
                  {
                    value: "decide-disposition",
                    label: t("inventory.features.recoveredItems.ui.page.action.disposition"),
                  },
                  { value: "record-value", label: t("inventory.features.recoveredItems.ui.page.action.value") },
                  { value: "correct-source", label: t("inventory.features.recoveredItems.ui.page.action.correct") },
                  { value: "merge", label: t("inventory.features.recoveredItems.ui.page.action.merge") },
                ]}
                required
              />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.policy.version")} name="policyVersion" />
              <TextInput
                label={t("inventory.features.recoveredItems.ui.page.evidence.references")}
                name="evidenceReferences"
                required
              />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.catalog.item")} name="catalogItemId" />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.product")} name="productId" />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.condition")} name="conditionGrade" />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.authenticity.outcome")} name="outcome" />
              <TextInput
                label={t("inventory.features.recoveredItems.ui.page.authenticity.reference")}
                name="reviewReference"
              />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.owner")} name="legalOwner" />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.authority.kind")} name="authorityKind" />
              <TextInput
                label={t("inventory.features.recoveredItems.ui.page.allowed.dispositions")}
                name="allowedDispositions"
              />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.disposition")} name="disposition" />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.target.account")} name="targetAccountId" />
              <TextInput
                label={t("inventory.features.recoveredItems.ui.page.storage.location")}
                name="storageLocationId"
              />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.reason")} name="reasonCode" />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.recovery.type")} name="recoveryType" />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.recovery.id")} name="recoveryId" />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.gross.amount")} name="grossAmount" />
              <TextInput label={t("inventory.features.recoveredItems.ui.page.cost.amount")} name="costAmount" />
              <TextInput
                label={t("inventory.features.recoveredItems.ui.page.currency")}
                name="currencyCode"
                defaultValue="USD"
              />
              <TextInput
                label={t("inventory.features.recoveredItems.ui.page.corrected.return.shipment")}
                name="correctedReturnShipmentId"
              />
              <TextInput
                label={t("inventory.features.recoveredItems.ui.page.canonical.item")}
                name="canonicalRecoveredItemId"
              />
              <Button type="submit">{t("inventory.features.recoveredItems.ui.page.submit")}</Button>
            </Form>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
