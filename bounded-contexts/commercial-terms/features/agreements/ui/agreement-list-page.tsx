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
import type { CommercialAgreementViewModel } from "./contracts";

function statusTone(status: string) {
  return status === "active" ? "accent" : "warning";
}

export function AgreementListPage({
  items,
  errorMessage,
}: {
  items: readonly CommercialAgreementViewModel[];
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Admin"
        title="Commercial Agreements"
        description="Manage account-specific overrides for marketplace and payment fees."
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Create Agreement">
        <Card>
          <form method="post">
            <Stack gap={3}>
              <TextInput label="Label" name="label" required />
              <TextInput label="Account ID" name="accountId" required />
              <NumberInput
                label="Marketplace Fee (bps)"
                name="marketplaceFeePercentageBps"
                min="0"
                defaultValue="700"
                required
              />
              <TextInput
                label="Marketplace Fixed Amount"
                name="marketplaceFeeFixedAmount"
                inputMode="decimal"
                defaultValue="0.05"
                required
              />
              <NumberInput
                label="Payment Fee (bps)"
                name="paymentFeePercentageBps"
                min="0"
                defaultValue="275"
                required
              />
              <TextInput
                label="Payment Fixed Amount"
                name="paymentFeeFixedAmount"
                inputMode="decimal"
                defaultValue="0.25"
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
              <Button type="submit">Create agreement</Button>
            </Stack>
          </form>
        </Card>
      </PageSection>

      <PageSection title="Current Agreements">
        <DataTable
          rows={[...items]}
          getRowId={(row) => row.agreement_id}
          columns={[
            {
              key: "label",
              header: "Agreement",
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.label}</Text>
                  <Text size="sm" tone="secondary">
                    {row.account_display_name ?? row.account_id}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "fees",
              header: "Fees",
              cell: (row) => (
                <Stack gap={1}>
                  <Text size="sm">
                    Marketplace: {row.marketplace_fee_percentage_bps} bps + $
                    {row.marketplace_fee_fixed_amount}
                  </Text>
                  <Text size="sm" tone="secondary">
                    Payment: {row.payment_fee_percentage_bps} bps + ${row.payment_fee_fixed_amount}
                  </Text>
                </Stack>
              ),
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
                <LinkButton href={`/commercial-terms/agreements/${row.agreement_id}`} tone="secondary" size="sm">
                  Open
                </LinkButton>
              ),
            },
          ]}
          emptyTitle="No agreements yet"
          emptyDescription="Create an account-specific agreement to override default schedules."
        />
      </PageSection>
    </Page>
  );
}
