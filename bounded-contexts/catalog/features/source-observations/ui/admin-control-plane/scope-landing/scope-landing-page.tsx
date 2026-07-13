import { Badge, Inline, Select, StatusPill, Text, type BadgeTone, type DataColumn } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { useSearchParams } from "react-router";
import { catalogScopeProductDomains } from "../../../../scope-registry/domain/contract";
import { EntityListPage } from "../../../../../support/shell-support/ui/entity-list-page";
import {
  useCatalogListQueryControls,
  type CatalogListQuery,
} from "../../../../../support/shell-support/list-query-state";
import type {
  CatalogScopeLandingReadModel,
  CatalogScopeLandingRow,
  CatalogScopePromotionReadiness,
  CatalogScopeSyncFreshness,
} from "./scope-landing-read-model";

const ALL_VALUE = "__all__";

const LIFECYCLE_STATUS_VALUES = ["draft", "active", "deprecated", "archived"] as const;

const promotionReadinessTone: Record<CatalogScopePromotionReadiness, BadgeTone> = {
  unpublished: "warning",
  live: "success",
  deprecated: "neutral",
  archived: "neutral",
};

const syncFreshnessTone: Record<CatalogScopeSyncFreshness, BadgeTone> = {
  fresh: "success",
  stale: "warning",
};

function promotionReadinessLabel(readiness: CatalogScopePromotionReadiness): string {
  switch (readiness) {
    case "unpublished":
      return t("catalog.features.sourceObservations.ui.scopeLanding.promotion.unpublished");
    case "live":
      return t("catalog.features.sourceObservations.ui.scopeLanding.promotion.live");
    case "deprecated":
      return t("catalog.features.sourceObservations.ui.scopeLanding.promotion.deprecated");
    case "archived":
      return t("catalog.features.sourceObservations.ui.scopeLanding.promotion.archived");
  }
}

function syncFreshnessLabel(freshness: CatalogScopeSyncFreshness): string {
  switch (freshness) {
    case "fresh":
      return t("catalog.features.sourceObservations.ui.scopeLanding.sync.fresh");
    case "stale":
      return t("catalog.features.sourceObservations.ui.scopeLanding.sync.stale");
  }
}

export type CatalogScopeLandingPageProps = Readonly<{
  readModel: CatalogScopeLandingReadModel;
  query: CatalogListQuery;
  productDomain: string;
  loading: boolean;
  error: string | null;
}>;

export function CatalogScopeLandingPage({
  readModel,
  query,
  productDomain,
  loading,
  error,
}: CatalogScopeLandingPageProps) {
  const controls = useCatalogListQueryControls(query);
  const [, setSearchParams] = useSearchParams();

  function setProductDomain(value: string) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) {
          next.set("productDomain", value);
        } else {
          next.delete("productDomain");
        }
        next.delete("page");
        return next;
      },
      { preventScrollReset: true },
    );
  }

  const activeFilterCount = [controls.search, controls.status, controls.language, productDomain].filter(Boolean).length;

  const columns: DataColumn<CatalogScopeLandingRow>[] = [
    {
      key: "scope",
      header: t("catalog.features.sourceObservations.ui.scopeLanding.column.scope"),
      cell: (row) => (
        <Inline gap={2} align="center">
          <Text weight="semibold">{row.name}</Text>
          {row.officialSetCode ? <StatusPill tone="neutral">{row.officialSetCode}</StatusPill> : null}
        </Inline>
      ),
    },
    {
      key: "domain",
      header: t("catalog.features.sourceObservations.ui.scopeLanding.column.domain"),
      cell: (row) => (
        <Text>
          {row.productDomain} · {row.scopeKind}
        </Text>
      ),
    },
    {
      key: "coverage",
      header: t("catalog.features.sourceObservations.ui.scopeLanding.column.coverage"),
      cell: (row) =>
        row.languageEditionCount > 0 ? (
          <Text>
            {t("catalog.features.sourceObservations.ui.scopeLanding.coverage.editions", {
              count: row.languageEditionCount,
              editions: row.languageEditions.join(", "),
            })}
          </Text>
        ) : (
          <Text tone="secondary">{t("catalog.features.sourceObservations.ui.scopeLanding.coverage.none")}</Text>
        ),
    },
    {
      key: "promotion",
      header: t("catalog.features.sourceObservations.ui.scopeLanding.column.promotion"),
      cell: (row) => (
        <Badge tone={promotionReadinessTone[row.promotionReadiness]}>
          {promotionReadinessLabel(row.promotionReadiness)}
        </Badge>
      ),
    },
    {
      key: "sync",
      header: t("catalog.features.sourceObservations.ui.scopeLanding.column.sync"),
      cell: (row) => <Badge tone={syncFreshnessTone[row.syncFreshness]}>{syncFreshnessLabel(row.syncFreshness)}</Badge>,
    },
  ];

  return (
    <EntityListPage<CatalogScopeLandingRow>
      title={t("catalog.features.sourceObservations.ui.scopeLanding.title")}
      entityName={t("catalog.features.sourceObservations.ui.scopeLanding.entityName")}
      items={readModel.rows as CatalogScopeLandingRow[]}
      total={readModel.counts.total}
      loading={loading}
      error={error}
      columns={columns}
      getRowId={(row) => row.scopeRecordId}
      getHref={(row) => row.detailHref}
      search={controls.search}
      onSearchChange={controls.setSearch}
      statusFilter={controls.status}
      onStatusFilterChange={controls.setStatus}
      statusOptions={LIFECYCLE_STATUS_VALUES.map((value) => ({ label: value, value }))}
      activeFilterCount={activeFilterCount}
      page={controls.page}
      pageSize={controls.pageSize}
      onPageChange={controls.setPage}
      extraFilters={
        <>
          <Select
            key="productDomain"
            label={t("catalog.features.sourceObservations.ui.scopeLanding.filter.productDomain")}
            value={productDomain || ALL_VALUE}
            onValueChange={(value) => setProductDomain(value === ALL_VALUE ? "" : value)}
            items={[
              { label: t("catalog.features.sourceObservations.ui.scopeLanding.filter.allDomains"), value: ALL_VALUE },
              ...catalogScopeProductDomains.map((value) => ({ label: value, value })),
            ]}
          />
          <Select
            key="language"
            label={t("catalog.features.sourceObservations.ui.scopeLanding.filter.language")}
            value={controls.language || ALL_VALUE}
            onValueChange={(value) => controls.setLanguage(value === ALL_VALUE ? "" : value)}
            items={[
              { label: t("catalog.features.sourceObservations.ui.scopeLanding.filter.allLanguages"), value: ALL_VALUE },
              ...readModel.facets.languageEditions.map((value) => ({ label: value, value })),
            ]}
          />
        </>
      }
    />
  );
}
