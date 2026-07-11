import { t } from "@chase-sets/localization";
import { useLocation, useNavigate } from "react-router";
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
  Pagination,
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
  pagination,
  errorMessage,
  loadErrorMessage,
}: {
  items: readonly CommercialAgreementViewModel[];
  pagination?: Readonly<{ limit: number; offset: number; total: number }>;
  errorMessage?: string | null;
  loadErrorMessage?: string | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const pageSize = pagination?.limit ?? items.length;
  const currentPage = pagination && pageSize > 0 ? Math.floor(pagination.offset / pageSize) + 1 : 1;
  const totalPages = pagination && pageSize > 0 ? Math.max(1, Math.ceil(pagination.total / pageSize)) : 1;
  const showPagination = Boolean(pagination && (pagination.total > pageSize || pagination.offset > 0));

  function navigateToPage(page: number) {
    if (!pagination) {
      return;
    }

    const searchParams = new URLSearchParams(location.search);
    searchParams.set("limit", String(pageSize));
    searchParams.set("offset", String((page - 1) * pageSize));
    navigate(`${location.pathname}?${searchParams.toString()}${location.hash}`);
  }

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
        {showPagination ? (
          <Pagination page={currentPage} totalPages={totalPages} onPageChange={navigateToPage} />
        ) : null}
      </PageSection>
    </Page>
  );
}
