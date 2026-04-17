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
        eyebrow="Admin"
        title={schedule.label}
        description="Inspect the default commercial terms for an account type."
        actions={
          <LinkButton href="/commercial-terms/schedules" tone="secondary">
            Back to schedules
          </LinkButton>
        }
      />
      <PageSection title="Schedule">
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(schedule.status)}>{schedule.status}</Badge>
            <Text>Schedule ID: {schedule.schedule_id}</Text>
            <Text>Account Type: {schedule.account_type}</Text>
            <Text>
              Marketplace Fee: {schedule.marketplace_fee_percentage_bps} bps + $
              {schedule.marketplace_fee_fixed_amount}
            </Text>
            <Text>
              Payment Fee: {schedule.payment_fee_percentage_bps} bps + $
              {schedule.payment_fee_fixed_amount}
            </Text>
            <Text>Effective From: {schedule.effective_from}</Text>
            <Text>Effective Until: {schedule.effective_until ?? "Open-ended"}</Text>
            <Text>Updated At: {schedule.updated_at}</Text>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
