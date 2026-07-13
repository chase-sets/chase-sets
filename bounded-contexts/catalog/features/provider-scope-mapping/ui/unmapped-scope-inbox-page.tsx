import { t } from "@chase-sets/localization";
import { useMemo } from "react";
import {
  Banner,
  EmptyState,
  LinkButton,
  LoadingSpinner,
  Page,
  PageHeader,
  StatusPill,
  DataTable,
  type DataColumn,
} from "@chase-sets/design-system";
import { toCatalogAdminHref } from "../../../support/shell-support/ui/catalog-admin-hrefs";
import type { UnmappedScopeInboxGroup, UnmappedScopeInboxReadModel } from "./contracts";
import { useUnmappedScopeInbox } from "./use-provider-scope-mapping";

const columns: DataColumn<UnmappedScopeInboxGroup>[] = [
  {
    key: "scopeName",
    header: t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.scope"),
    cell: (row) => row.scopeName,
  },
  {
    key: "productDomain",
    header: t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.product.domain"),
    cell: (row) => row.productDomain,
  },
  {
    key: "scopeKind",
    header: t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.scope.kind"),
    cell: (row) => row.scopeKind,
  },
  {
    key: "officialSetCode",
    header: t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.official.code"),
    cell: (row) => row.officialSetCode ?? "—",
  },
  {
    key: "status",
    header: t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.status"),
    cell: (row) =>
      row.isDraftCanonicalRecord ? (
        <StatusPill tone="warning">
          {t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.new.canonical.record")}
        </StatusPill>
      ) : (
        <StatusPill tone="neutral">
          {t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.existing.record")}
        </StatusPill>
      ),
  },
  {
    key: "counts",
    header: t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.pending.proposals"),
    cell: (row) =>
      t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.pending.count", {
        total: row.counts.total,
        highConfidence: row.counts.highConfidence,
      }),
  },
];

export function UnmappedScopeInboxPage({ initialData }: { initialData?: UnmappedScopeInboxReadModel | null }) {
  const { data, loading, error } = useUnmappedScopeInbox(initialData);

  const columnsWithView = useMemo<DataColumn<UnmappedScopeInboxGroup>[]>(
    () => [
      ...columns,
      {
        key: "__view__",
        header: "",
        cell: (row) => (
          <LinkButton href={toCatalogAdminHref(`/scope-coverage/${row.scopeRecordId}`)} size="sm" tone="secondary">
            {t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.review")}
          </LinkButton>
        ),
      },
    ],
    [],
  );

  return (
    <Page>
      <PageHeader
        title={t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.unmapped.scope.inbox")}
        description={t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.description")}
      />
      {error && (
        <Banner
          tone="danger"
          title={t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.error")}
          description={error}
        />
      )}
      {data && (
        <Banner
          tone={data.counts.totalGroups > 0 ? "warning" : "success"}
          title={t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.summary.title")}
          description={t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.summary.description", {
            groups: data.counts.totalGroups,
            candidates: data.counts.totalCandidates,
            highConfidence: data.counts.highConfidenceCandidates,
          })}
        />
      )}
      {loading && !data ? (
        <LoadingSpinner label={t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.loading")} />
      ) : data && data.groups.length === 0 ? (
        <EmptyState
          title={t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.nothing.pending.title")}
          description={t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.nothing.pending.description")}
          icon="checkCircle"
        />
      ) : data ? (
        <DataTable
          rows={[...data.groups]}
          columns={columnsWithView}
          getRowId={(row) => row.scopeRecordId}
          emptyTitle={t("catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.nothing.pending.title")}
        />
      ) : null}
    </Page>
  );
}
