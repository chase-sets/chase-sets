import { formatMoney, t } from "@chase-sets/localization";
import {
  Form,
  Badge,
  Button,
  Card,
  DataTable,
  LinkButton,
  NativeSelect,
  NumberInput,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { CommercialTermsScheduleViewModel } from "./contracts";

function statusTone(status: string) {
  return status === "active" ? "accent" : "warning";
}

function formatWindow(from: string, until: string | null) {
  return `${from} - ${until ?? t("commercialTerms.features.schedules.ui.scheduleDetailPage.open.ended")}`;
}

export function ScheduleDetailPage({
  schedule,
  errorMessage,
}: {
  schedule: CommercialTermsScheduleViewModel;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("commercialTerms.features.schedules.ui.scheduleDetailPage.admin")}
        title={schedule.label}
        description={t(
          "commercialTerms.features.schedules.ui.scheduleDetailPage.inspect.the.default.commercial.terms.for",
        )}
        actions={
          <LinkButton href="/commerce/terms/schedules" tone="secondary">
            {t("commercialTerms.features.schedules.ui.scheduleDetailPage.back.to.schedules")}
          </LinkButton>
        }
      />
      <PageSection title={t("commercialTerms.features.schedules.ui.scheduleDetailPage.schedule")}>
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(schedule.status)}>{schedule.status}</Badge>
            <Text>
              {t("commercialTerms.features.schedules.ui.scheduleDetailPage.schedule.id")}
              {schedule.schedule_id}
            </Text>
            <Text>
              {t("commercialTerms.features.schedules.ui.scheduleDetailPage.account.type")}
              {schedule.account_type}
            </Text>
            <Text>
              {t("commercialTerms.features.schedules.ui.scheduleDetailPage.marketplace.fee")}
              {schedule.marketplace_sales_fee_percentage_bps}{" "}
              {t("commercialTerms.features.schedules.ui.scheduleDetailPage.bps")}
              {" + "}
              {formatMoney(schedule.marketplace_sales_fee_fixed_amount, "USD")}
            </Text>
            <Text>
              {t("commercialTerms.features.schedules.ui.scheduleDetailPage.shipping.allowance")}
              {schedule.shipping_allowance_percentage_bps}{" "}
              {t("commercialTerms.features.schedules.ui.scheduleDetailPage.bps")}
            </Text>
            <Text>
              {t("commercialTerms.features.schedules.ui.scheduleDetailPage.effective.from")}
              {schedule.effective_from}
            </Text>
            <Text>
              {t("commercialTerms.features.schedules.ui.scheduleDetailPage.effective.until")}
              {schedule.effective_until ?? t("commercialTerms.features.schedules.ui.scheduleDetailPage.open.ended")}
            </Text>
            <Text>
              {t("commercialTerms.features.schedules.ui.scheduleDetailPage.updated.at")}
              {schedule.updated_at}
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("commercialTerms.features.schedules.ui.scheduleDetailPage.history")}>
        <DataTable
          rows={[...(schedule.history ?? [])]}
          getRowId={(row) => row.history_id}
          columns={[
            {
              key: "event_type",
              header: t("commercialTerms.features.schedules.ui.scheduleDetailPage.history.event"),
              cell: (row) => row.event_type,
            },
            {
              key: "actor_user_id",
              header: t("commercialTerms.features.schedules.ui.scheduleDetailPage.history.actor"),
              cell: (row) => row.actor_user_id,
            },
            {
              key: "status",
              header: t("commercialTerms.features.schedules.ui.scheduleDetailPage.status"),
              cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: "window",
              header: t("commercialTerms.features.schedules.ui.scheduleDetailPage.history.window"),
              cell: (row) => formatWindow(row.effective_from, row.effective_until),
            },
            {
              key: "recorded_at",
              header: t("commercialTerms.features.schedules.ui.scheduleDetailPage.history.recorded"),
              cell: (row) => row.recorded_at,
            },
          ]}
          emptyTitle={t("commercialTerms.features.schedules.ui.scheduleDetailPage.history.empty")}
          emptyDescription={t("commercialTerms.features.schedules.ui.scheduleDetailPage.history.description")}
        />
      </PageSection>

      <PageSection title={t("commercialTerms.features.schedules.ui.scheduleDetailPage.revise.schedule")}>
        <Card>
          <Form spacing="none" method="post">
            <Stack gap={3}>
              {errorMessage ? <Text>{errorMessage}</Text> : null}
              <TextInput
                label={t("commercialTerms.features.schedules.ui.scheduleDetailPage.label")}
                name="label"
                defaultValue={schedule.label}
                required
              />
              <NumberInput
                label={t("commercialTerms.features.schedules.ui.scheduleDetailPage.marketplace.fee.bps")}
                name="marketplaceSalesFeePercentageBps"
                min="0"
                max="10000"
                defaultValue={String(schedule.marketplace_sales_fee_percentage_bps)}
                required
              />
              <TextInput
                label={t("commercialTerms.features.schedules.ui.scheduleDetailPage.marketplace.fixed.amount")}
                name="marketplaceSalesFeeFixedAmount"
                inputMode="decimal"
                defaultValue={schedule.marketplace_sales_fee_fixed_amount}
                required
              />
              <NumberInput
                label={t("commercialTerms.features.schedules.ui.scheduleDetailPage.shipping.allowance.bps")}
                name="shippingAllowancePercentageBps"
                min="0"
                max="10000"
                defaultValue={String(schedule.shipping_allowance_percentage_bps)}
                required
              />
              <NativeSelect
                label={t("commercialTerms.features.schedules.ui.scheduleDetailPage.status")}
                name="status"
                required
                defaultValue={schedule.status}
                items={[
                  { value: "active", label: t("commercialTerms.features.schedules.ui.scheduleDetailPage.active") },
                  { value: "inactive", label: t("commercialTerms.features.schedules.ui.scheduleDetailPage.inactive") },
                ]}
              />
              <TextInput
                label={t("commercialTerms.features.schedules.ui.scheduleDetailPage.effective.from")}
                name="effectiveFrom"
                defaultValue={schedule.effective_from}
                required
              />
              <TextInput
                label={t("commercialTerms.features.schedules.ui.scheduleDetailPage.effective.until")}
                name="effectiveUntil"
                defaultValue={schedule.effective_until ?? ""}
                placeholder={t("commercialTerms.features.schedules.ui.scheduleDetailPage.optional.iso.timestamp")}
              />
              <Button type="submit">
                {t("commercialTerms.features.schedules.ui.scheduleDetailPage.save.schedule")}
              </Button>
            </Stack>
          </Form>
        </Card>
      </PageSection>
    </Page>
  );
}
