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
        eyebrow={t("commercialTerms.features.agreements.ui.agreementListPage.admin")}
        title={t("commercialTerms.features.agreements.ui.agreementListPage.commercial.agreements")}
        description={t("commercialTerms.features.agreements.ui.agreementListPage.manage.account.specific.overrides.for.marketplace")}
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("commercialTerms.features.agreements.ui.agreementListPage.create.agreement")}>
        <Card>
          <form method="post">
            <Stack gap={3}>
              <TextInput label={t("commercialTerms.features.agreements.ui.agreementListPage.label")} name="label" required />
              <TextInput label={t("commercialTerms.features.agreements.ui.agreementListPage.account.id")} name="accountId" required />
              <NumberInput
                label={t("commercialTerms.features.agreements.ui.agreementListPage.marketplace.fee.bps")}
                name="marketplaceFeePercentageBps"
                min="0"
                defaultValue="700"
                required
              />
              <TextInput
                label={t("commercialTerms.features.agreements.ui.agreementListPage.marketplace.fixed.amount")}
                name="marketplaceFeeFixedAmount"
                inputMode="decimal"
                defaultValue="0.05"
                required
              />
              <NativeSelect
                label={t("commercialTerms.features.agreements.ui.agreementListPage.status")}
                name="status"
                required
                defaultValue="active"
                items={[
                  { value: "active", label: t("commercialTerms.features.agreements.ui.agreementListPage.active") },
                  { value: "inactive", label: t("commercialTerms.features.agreements.ui.agreementListPage.inactive") },
                ]}
              />
              <TextInput
                label={t("commercialTerms.features.agreements.ui.agreementListPage.effective.from")}
                name="effectiveFrom"
                defaultValue={new Date().toISOString()}
                required
              />
              <TextInput
                label={t("commercialTerms.features.agreements.ui.agreementListPage.effective.until")}
                name="effectiveUntil"
                placeholder={t("commercialTerms.features.agreements.ui.agreementListPage.optional.iso.timestamp")}
              />
              <Button type="submit">{t("commercialTerms.features.agreements.ui.agreementListPage.create.agreement.2")}</Button>
            </Stack>
          </form>
        </Card>
      </PageSection>

      <PageSection title={t("commercialTerms.features.agreements.ui.agreementListPage.current.agreements")}>
        <DataTable
          rows={[...items]}
          getRowId={(row) => row.agreement_id}
          columns={[
            {
              key: "label",
              header: t("commercialTerms.features.agreements.ui.agreementListPage.agreement"),
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
              header: t("commercialTerms.features.agreements.ui.agreementListPage.fees"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text size="sm">
                    {t("commercialTerms.features.agreements.ui.agreementListPage.marketplace")}{row.marketplace_fee_percentage_bps} {t("commercialTerms.features.agreements.ui.agreementListPage.bps")}{row.marketplace_fee_fixed_amount}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "status",
              header: t("commercialTerms.features.agreements.ui.agreementListPage.status.2"),
              cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: "actions",
              header: t("commercialTerms.features.agreements.ui.agreementListPage.actions"),
              cell: (row) => (
                <LinkButton href={`/commercial-terms/agreements/${row.agreement_id}`} tone="secondary" size="sm">
                  {t("commercialTerms.features.agreements.ui.agreementListPage.open")}</LinkButton>
              ),
            },
          ]}
          emptyTitle={t("commercialTerms.features.agreements.ui.agreementListPage.no.agreements.yet")}
          emptyDescription={t("commercialTerms.features.agreements.ui.agreementListPage.create.an.account.specific.agreement.to")}
        />
      </PageSection>
    </Page>
  );
}
