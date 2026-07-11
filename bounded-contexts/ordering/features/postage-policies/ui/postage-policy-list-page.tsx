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
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { defaultPostagePolicy } from "@chase-sets/product-measures";
import type { PostagePolicyAdminViewModel } from "./contracts";
import { PostagePolicyFormFields } from "./postage-policy-form-fields";

function statusTone(status: string) {
  return status === "active" ? "success" : status === "retired" ? "neutral" : "warning";
}

function formatRequirementSummary(policy: PostagePolicyAdminViewModel["payload"]) {
  const parcel =
    policy.parcelRequiredShippingOptions.join(", ") || t("ordering.features.postagePolicies.ui.common.none");
  const signature = [
    ...policy.signatureRequiredShippingOptions,
    policy.signatureRequiredDeclaredValueAmount == null
      ? null
      : t("ordering.features.postagePolicies.ui.list.signature.value.threshold", {
          value: policy.signatureRequiredDeclaredValueAmount,
        }),
    ...policy.signatureRequiredPhysicalFlags,
  ].filter(Boolean);
  const insurance =
    policy.insuranceRequiredDeclaredValueAmount == null
      ? t("ordering.features.postagePolicies.ui.common.none")
      : t("ordering.features.postagePolicies.ui.list.insurance.value.threshold", {
          value: policy.insuranceRequiredDeclaredValueAmount,
        });
  return t("ordering.features.postagePolicies.ui.list.requirement.summary", {
    parcel,
    signature: signature.join(", ") || t("ordering.features.postagePolicies.ui.common.none"),
    insurance,
  });
}

export function PostagePolicyListPage({
  items,
  pagination,
  errorMessage,
}: {
  items: readonly PostagePolicyAdminViewModel[];
  pagination?: Readonly<{ limit: number; offset: number; total: number }>;
  errorMessage?: string | null;
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
        eyebrow={t("ordering.features.postagePolicies.ui.common.ordering")}
        title={t("ordering.features.postagePolicies.ui.list.title")}
        description={t("ordering.features.postagePolicies.ui.list.description")}
      />

      <Banner
        tone="info"
        title={t("ordering.features.postagePolicies.ui.list.immutable.title")}
        description={t("ordering.features.postagePolicies.ui.list.immutable.description")}
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("ordering.features.postagePolicies.ui.list.create.draft")}>
        <Card>
          <Form spacing="none" method="post">
            <Stack gap={4}>
              <TextInput
                label={t("ordering.features.postagePolicies.ui.common.label")}
                name="label"
                defaultValue={t("ordering.features.postagePolicies.ui.list.default.policy")}
                required
              />
              <TextInput
                label={t("ordering.features.postagePolicies.ui.common.effective.from")}
                name="effectiveFrom"
                defaultValue={new Date().toISOString()}
                required
              />
              <TextInput
                label={t("ordering.features.postagePolicies.ui.common.effective.until")}
                name="effectiveUntil"
              />
              <PostagePolicyFormFields policy={defaultPostagePolicy} />
              <Button type="submit">{t("ordering.features.postagePolicies.ui.list.create.draft.action")}</Button>
            </Stack>
          </Form>
        </Card>
      </PageSection>

      <PageSection title={t("ordering.features.postagePolicies.ui.list.policies")}>
        <DataTable
          rows={[...items]}
          getRowId={(row) => row.policy_id}
          columns={[
            {
              key: "label",
              header: t("ordering.features.postagePolicies.ui.list.policy"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.label}</Text>
                  <Text size="sm" tone="secondary">
                    {row.policy_version}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "requirements",
              header: t("ordering.features.postagePolicies.ui.list.requirements"),
              cell: (row) => formatRequirementSummary(row.payload),
            },
            {
              key: "status",
              header: t("ordering.features.postagePolicies.ui.common.status"),
              cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: "updated",
              header: t("ordering.features.postagePolicies.ui.list.updated"),
              cell: (row) => row.updated_at,
            },
            {
              key: "actions",
              header: t("ordering.features.postagePolicies.ui.list.actions"),
              cell: (row) => (
                <LinkButton href={`/commerce/postage-policies/${row.policy_id}`} tone="secondary" size="sm">
                  {t("ordering.features.postagePolicies.ui.list.open")}
                </LinkButton>
              ),
            },
          ]}
          emptyTitle={t("ordering.features.postagePolicies.ui.list.empty.title")}
          emptyDescription={t("ordering.features.postagePolicies.ui.list.empty.description")}
        />
        {showPagination ? (
          <Pagination page={currentPage} totalPages={totalPages} onPageChange={navigateToPage} />
        ) : null}
      </PageSection>
    </Page>
  );
}
