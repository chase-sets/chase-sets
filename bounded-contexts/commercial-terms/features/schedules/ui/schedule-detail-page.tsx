import { t } from "@chase-sets/localization";
import {
  Badge,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { CommercialTermsScheduleViewModel } from "./contracts";

function statusTone(status: string) {
  return status === "active" ? "accent" : "warning";
}

export function ScheduleDetailPage({ schedule }: { schedule: CommercialTermsScheduleViewModel }) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("commercialTerms.features.schedules.ui.scheduleDetailPage.admin")}
        title={schedule.label}
        description={t("commercialTerms.features.schedules.ui.scheduleDetailPage.inspect.the.default.commercial.terms.for")}
        actions={
          <LinkButton href="/commercial-terms/schedules" tone="secondary">
            {t("commercialTerms.features.schedules.ui.scheduleDetailPage.back.to.schedules")}</LinkButton>
        }
      />
      <PageSection title={t("commercialTerms.features.schedules.ui.scheduleDetailPage.schedule")}>
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(schedule.status)}>{schedule.status}</Badge>
            <Text>{t("commercialTerms.features.schedules.ui.scheduleDetailPage.schedule.id")}{schedule.schedule_id}</Text>
            <Text>{t("commercialTerms.features.schedules.ui.scheduleDetailPage.account.type")}{schedule.account_type}</Text>
            <Text>
              {t("commercialTerms.features.schedules.ui.scheduleDetailPage.marketplace.fee")}{schedule.marketplace_fee_percentage_bps} {t("commercialTerms.features.schedules.ui.scheduleDetailPage.bps")}{schedule.marketplace_fee_fixed_amount}
            </Text>
            <Text>
              {t("commercialTerms.features.schedules.ui.scheduleDetailPage.payment.fee")}{schedule.payment_fee_percentage_bps} {t("commercialTerms.features.schedules.ui.scheduleDetailPage.bps.2")}{schedule.payment_fee_fixed_amount}
            </Text>
            <Text>{t("commercialTerms.features.schedules.ui.scheduleDetailPage.effective.from")}{schedule.effective_from}</Text>
            <Text>{t("commercialTerms.features.schedules.ui.scheduleDetailPage.effective.until")}{schedule.effective_until ?? t("commercialTerms.features.schedules.ui.scheduleDetailPage.open.ended")}</Text>
            <Text>{t("commercialTerms.features.schedules.ui.scheduleDetailPage.updated.at")}{schedule.updated_at}</Text>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
