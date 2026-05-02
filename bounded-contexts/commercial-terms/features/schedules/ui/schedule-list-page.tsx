import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Card,
  DataTable,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
  NumberInput,
  NativeSelect,
} from "@chase-sets/design-system";
import type { CommercialTermsScheduleViewModel } from "./contracts";

function statusTone(status: string) {
  return status === "active" ? "accent" : "warning";
}

export function ScheduleListPage({
  items,
  errorMessage,
}: {
  items: readonly CommercialTermsScheduleViewModel[];
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("commercialTerms.features.schedules.ui.scheduleListPage.admin")}
        title={t("commercialTerms.features.schedules.ui.scheduleListPage.fee.schedules")}
        description={t("commercialTerms.features.schedules.ui.scheduleListPage.manage.default.marketplace.and.payment.fee")}
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("commercialTerms.features.schedules.ui.scheduleListPage.create.schedule")}>
        <Card>
          <form method="post">
            <Stack gap={3}>
              <TextInput label={t("commercialTerms.features.schedules.ui.scheduleListPage.label")} name="label" required />
              <NativeSelect
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.account.type")}
                name="accountType"
                required
                defaultValue="business"
                items={[
                  { value: "personal", label: t("commercialTerms.features.schedules.ui.scheduleListPage.personal") },
                  { value: "business", label: t("commercialTerms.features.schedules.ui.scheduleListPage.business") },
                  { value: "enterprise", label: t("commercialTerms.features.schedules.ui.scheduleListPage.enterprise") },
                ]}
              />
              <NumberInput
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.marketplace.fee.bps")}
                name="marketplaceFeePercentageBps"
                min="0"
                defaultValue="850"
                required
              />
              <TextInput
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.marketplace.fixed.amount")}
                name="marketplaceFeeFixedAmount"
                inputMode="decimal"
                defaultValue="0.10"
                required
              />
              <NumberInput
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.payment.fee.bps")}
                name="paymentFeePercentageBps"
                min="0"
                defaultValue="290"
                required
              />
              <TextInput
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.payment.fixed.amount")}
                name="paymentFeeFixedAmount"
                inputMode="decimal"
                defaultValue="0.30"
                required
              />
              <NativeSelect
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.status")}
                name="status"
                required
                defaultValue="active"
                items={[
                  { value: "active", label: t("commercialTerms.features.schedules.ui.scheduleListPage.active") },
                  { value: "inactive", label: t("commercialTerms.features.schedules.ui.scheduleListPage.inactive") },
                ]}
              />
              <TextInput
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.effective.from")}
                name="effectiveFrom"
                defaultValue={new Date().toISOString()}
                required
              />
              <TextInput
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.effective.until")}
                name="effectiveUntil"
                placeholder={t("commercialTerms.features.schedules.ui.scheduleListPage.optional.iso.timestamp")}
              />
              <Button type="submit">{t("commercialTerms.features.schedules.ui.scheduleListPage.create.schedule.2")}</Button>
            </Stack>
          </form>
        </Card>
      </PageSection>

      <PageSection title={t("commercialTerms.features.schedules.ui.scheduleListPage.current.schedules")}>
        <DataTable
          rows={[...items]}
          getRowId={(row) => row.schedule_id}
          columns={[
            {
              key: "label",
              header: t("commercialTerms.features.schedules.ui.scheduleListPage.label.2"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.label}</Text>
                  <Text size="sm" tone="secondary">
                    {row.account_type}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "marketplace",
              header: t("commercialTerms.features.schedules.ui.scheduleListPage.marketplace.fee"),
              cell: (row) =>
                `${row.marketplace_fee_percentage_bps} bps + $${row.marketplace_fee_fixed_amount}`,
            },
            {
              key: "payment",
              header: t("commercialTerms.features.schedules.ui.scheduleListPage.payment.fee"),
              cell: (row) =>
                `${row.payment_fee_percentage_bps} bps + $${row.payment_fee_fixed_amount}`,
            },
            {
              key: "status",
              header: t("commercialTerms.features.schedules.ui.scheduleListPage.status.2"),
              cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: "actions",
              header: t("commercialTerms.features.schedules.ui.scheduleListPage.actions"),
              cell: (row) => (
                <LinkButton href={`/commercial-terms/schedules/${row.schedule_id}`} tone="secondary" size="sm">
                  {t("commercialTerms.features.schedules.ui.scheduleListPage.open")}</LinkButton>
              ),
            },
          ]}
          emptyTitle={t("commercialTerms.features.schedules.ui.scheduleListPage.no.schedules.yet")}
          emptyDescription={t("commercialTerms.features.schedules.ui.scheduleListPage.create.a.default.schedule.before.commercial")}
        />
      </PageSection>
    </Page>
  );
}
