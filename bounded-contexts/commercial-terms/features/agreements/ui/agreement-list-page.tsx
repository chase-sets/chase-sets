import { t } from "@chase-sets/localization";
import {
  Form,
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { AgreementCreateFields } from "./agreement-create-fields";
import type { CommercialAgreementViewModel } from "./contracts";

function statusTone(status: string) {
  return status === "active" ? "accent" : "warning";
}

export function AgreementListPage({
  items,
  errorMessage,
  loadErrorMessage,
}: {
  items: readonly CommercialAgreementViewModel[];
  errorMessage?: string | null;
  loadErrorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("commercialTerms.features.agreements.ui.agreementListPage.admin")}
        title={t("commercialTerms.features.agreements.ui.agreementListPage.commercial.agreements")}
        description={t(
          "commercialTerms.features.agreements.ui.agreementListPage.manage.account.specific.overrides.for.marketplace",
        )}
      />

      <Banner
        tone="warning"
        title={t("commercialTerms.features.agreements.ui.agreementListPage.fee.lock.permanence")}
        description={t("commercialTerms.features.agreements.ui.agreementListPage.fee.lock.permanence.description")}
      />

      {loadErrorMessage ? (
        <Banner
          tone="danger"
          title={t("commercialTerms.features.agreements.ui.agreementListPage.agreements.unavailable")}
          description={loadErrorMessage}
        />
      ) : null}

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("commercialTerms.features.agreements.ui.agreementListPage.create.agreement")}>
        <Card>
          <Form spacing="none" method="post">
            <AgreementCreateFields />
          </Form>
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
                    {t("commercialTerms.features.agreements.ui.agreementListPage.marketplace")}
                    {row.marketplace_sales_fee_percentage_bps}{" "}
                    {t("commercialTerms.features.agreements.ui.agreementListPage.bps")}
                    {row.marketplace_sales_fee_fixed_amount}
                  </Text>
                  <Text size="sm">
                    {t("commercialTerms.features.agreements.ui.agreementListPage.shipping.allowance")}
                    {row.shipping_allowance_percentage_bps}{" "}
                    {t("commercialTerms.features.agreements.ui.agreementListPage.bps")}
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
                <LinkButton href={`/commerce/terms/agreements/${row.agreement_id}`} tone="secondary" size="sm">
                  {t("commercialTerms.features.agreements.ui.agreementListPage.open")}
                </LinkButton>
              ),
            },
          ]}
          emptyTitle={t("commercialTerms.features.agreements.ui.agreementListPage.no.agreements.yet")}
          emptyDescription={t(
            "commercialTerms.features.agreements.ui.agreementListPage.create.an.account.specific.agreement.to",
          )}
        />
      </PageSection>
    </Page>
  );
}
