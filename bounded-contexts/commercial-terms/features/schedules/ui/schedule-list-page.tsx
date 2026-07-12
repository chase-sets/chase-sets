import { formatBpsPercent, formatMoney, t } from "@chase-sets/localization";
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
  TextInput,
  NumberField,
  NativeSelect,
} from "@chase-sets/design-system";
import type { CommercialTermsScheduleViewModel } from "./contracts";

function statusTone(status: string) {
  return status === "active" ? "accent" : "warning";
}

export function ScheduleListPage({
  items,
  pagination,
  errorMessage,
  loadErrorMessage,
}: {
  items: readonly CommercialTermsScheduleViewModel[];
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
        eyebrow={t("commercialTerms.features.schedules.ui.scheduleListPage.admin")}
        title={t("commercialTerms.features.schedules.ui.scheduleListPage.fee.schedules")}
        description={t(
          "commercialTerms.features.schedules.ui.scheduleListPage.manage.default.marketplace.fee.schedules",
        )}
      />

      <Banner
        tone="warning"
        title={t("commercialTerms.features.schedules.ui.scheduleListPage.fee.lock.permanence")}
        description={t("commercialTerms.features.schedules.ui.scheduleListPage.fee.lock.permanence.description")}
      />

      {loadErrorMessage ? (
        <Banner
          tone="danger"
          title={t("commercialTerms.features.schedules.ui.scheduleListPage.schedules.unavailable")}
          description={loadErrorMessage}
        />
      ) : null}

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("commercialTerms.features.schedules.ui.scheduleListPage.create.schedule")}>
        <Card>
          <Form spacing="none" method="post">
            <Stack gap={3}>
              <TextInput
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.label")}
                name="label"
                required
              />
              <NativeSelect
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.account.type")}
                name="accountType"
                required
                defaultValue="business"
                items={[
                  { value: "personal", label: t("commercialTerms.features.schedules.ui.scheduleListPage.personal") },
                  { value: "business", label: t("commercialTerms.features.schedules.ui.scheduleListPage.business") },
                  {
                    value: "enterprise",
                    label: t("commercialTerms.features.schedules.ui.scheduleListPage.enterprise"),
                  },
                ]}
              />
              <NumberField
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.marketplace.fee.bps")}
                name="marketplaceSalesFeePercentageBps"
                min={0}
                max={10000}
                defaultValue={850}
                required
              />
              <TextInput
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.marketplace.fixed.amount")}
                name="marketplaceSalesFeeFixedAmount"
                inputMode="decimal"
                defaultValue="0.10"
                required
              />
              <NumberField
                label={t("commercialTerms.features.schedules.ui.scheduleListPage.shipping.allowance.bps")}
                name="shippingAllowancePercentageBps"
                min={0}
                max={10000}
                defaultValue={500}
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
              <Button type="submit">
                {t("commercialTerms.features.schedules.ui.scheduleListPage.create.schedule.2")}
              </Button>
            </Stack>
          </Form>
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
                `${formatBpsPercent(row.marketplace_sales_fee_percentage_bps)} + ${formatMoney(row.marketplace_sales_fee_fixed_amount, "USD")}`,
            },
            {
              key: "shippingAllowance",
              header: t("commercialTerms.features.schedules.ui.scheduleListPage.shipping.allowance"),
              cell: (row) => formatBpsPercent(row.shipping_allowance_percentage_bps),
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
                <LinkButton href={`/commerce/terms/schedules/${row.schedule_id}`} tone="secondary" size="sm">
                  {t("commercialTerms.features.schedules.ui.scheduleListPage.open")}
                </LinkButton>
              ),
            },
          ]}
          emptyTitle={t("commercialTerms.features.schedules.ui.scheduleListPage.no.schedules.yet")}
          emptyDescription={t(
            "commercialTerms.features.schedules.ui.scheduleListPage.create.a.default.schedule.before.commercial",
          )}
        />
        {showPagination ? (
          <Pagination page={currentPage} totalPages={totalPages} onPageChange={navigateToPage} />
        ) : null}
      </PageSection>
    </Page>
  );
}
