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
        eyebrow="Admin"
        title="Fee Schedules"
        description="Manage default marketplace and payment fee schedules by account type."
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Create Schedule">
        <Card>
          <form method="post">
            <Stack gap={3}>
              <TextInput label="Label" name="label" required />
              <NativeSelect
                label="Account Type"
                name="accountType"
                required
                defaultValue="business"
                items={[
                  { value: "personal", label: "Personal" },
                  { value: "business", label: "Business" },
                  { value: "enterprise", label: "Enterprise" },
                ]}
              />
              <NumberInput
                label="Marketplace Fee (bps)"
                name="marketplaceFeePercentageBps"
                min="0"
                defaultValue="850"
                required
              />
              <TextInput
                label="Marketplace Fixed Amount"
                name="marketplaceFeeFixedAmount"
                inputMode="decimal"
                defaultValue="0.10"
                required
              />
              <NumberInput
                label="Payment Fee (bps)"
                name="paymentFeePercentageBps"
                min="0"
                defaultValue="290"
                required
              />
              <TextInput
                label="Payment Fixed Amount"
                name="paymentFeeFixedAmount"
                inputMode="decimal"
                defaultValue="0.30"
                required
              />
              <NativeSelect
                label="Status"
                name="status"
                required
                defaultValue="active"
                items={[
                  { value: "active", label: "Active" },
                  { value: "inactive", label: "Inactive" },
                ]}
              />
              <TextInput
                label="Effective From"
                name="effectiveFrom"
                defaultValue={new Date().toISOString()}
                required
              />
              <TextInput
                label="Effective Until"
                name="effectiveUntil"
                placeholder="Optional ISO timestamp"
              />
              <Button type="submit">Create schedule</Button>
            </Stack>
          </form>
        </Card>
      </PageSection>

      <PageSection title="Current Schedules">
        <DataTable
          rows={[...items]}
          getRowId={(row) => row.schedule_id}
          columns={[
            {
              key: "label",
              header: "Label",
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
              header: "Marketplace Fee",
              cell: (row) =>
                `${row.marketplace_fee_percentage_bps} bps + $${row.marketplace_fee_fixed_amount}`,
            },
            {
              key: "payment",
              header: "Payment Fee",
              cell: (row) =>
                `${row.payment_fee_percentage_bps} bps + $${row.payment_fee_fixed_amount}`,
            },
            {
              key: "status",
              header: "Status",
              cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: "actions",
              header: "Actions",
              cell: (row) => (
                <LinkButton href={`/commercial-terms/schedules/${row.schedule_id}`} tone="secondary" size="sm">
                  Open
                </LinkButton>
              ),
            },
          ]}
          emptyTitle="No schedules yet"
          emptyDescription="Create a default schedule before commercial terms are resolved for sellers."
        />
      </PageSection>
    </Page>
  );
}
