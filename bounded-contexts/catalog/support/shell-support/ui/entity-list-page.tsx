import { t } from "@chase-sets/localization";
import { useMemo, type ReactNode } from "react";
import {
  Button,
  DataTable,
  EmptyState,
  FilterBar,
  LinkButton,
  LoadingSpinner,
  Page,
  PageHeader,
  Stack,
  Banner,
  TextInput,
  Select,
  Inline,
  type DataColumn,
} from "@chase-sets/design-system";

const ALL_STATUSES = "__all__";
const CATALOG_ADMIN_BASE_PATH = "/catalog";

function toCatalogAdminHref(href: string) {
  if (!href.startsWith("/")) {
    return href;
  }

  if (
    href === CATALOG_ADMIN_BASE_PATH ||
    href.startsWith(`${CATALOG_ADMIN_BASE_PATH}/`)
  ) {
    return href;
  }

  return `${CATALOG_ADMIN_BASE_PATH}${href}`;
}

interface EntityListPageProps<T> {
  title: string;
  entityName: string;
  items: T[] | null;
  total?: number;
  loading: boolean;
  error: string | null;
  columns: DataColumn<T>[];
  getRowId: (row: T) => string;
  getHref: (row: T) => string;
  createButton?: ReactNode;
  search?: string;
  onSearchChange?: (value: string) => void;
  statusFilter?: string;
  onStatusFilterChange?: (value: string) => void;
  statusOptions?: { label: string; value: string }[];
  extraFilters?: ReactNode;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  isRowSelectable?: (row: T, index: number) => boolean;
  bulkActionBar?: ReactNode;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
}

export function EntityListPage<T>({
  title,
  entityName,
  items,
  total,
  loading,
  error,
  columns,
  getRowId,
  getHref,
  createButton,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  statusOptions,
  extraFilters,
  selectedKeys,
  onSelectionChange,
  isRowSelectable,
  bulkActionBar,
  page = 0,
  pageSize = 50,
  onPageChange,
}: EntityListPageProps<T>) {
  const totalPages = total !== undefined ? Math.ceil(total / pageSize) : 0;
  const showPagination = total !== undefined && total > pageSize;

  const columnsWithView = useMemo<DataColumn<T>[]>(() => [
    ...columns,
    {
      key: "__view__",
      header: "",
      cell: (row) => (
        <LinkButton href={toCatalogAdminHref(getHref(row))} size="sm" tone="secondary">
          {t("catalog.support.shellSupport.ui.entityListPage.view")}</LinkButton>
      ),
    },
  ], [columns, getHref]);

  return (
    <Page>
      <PageHeader
        title={title}
        actions={createButton}
      />
      <Stack gap={4}>
        {(onSearchChange || onStatusFilterChange || extraFilters) && (
          <FilterBar sticky={false}>
            {onSearchChange && (
              <TextInput
                label={t("catalog.support.shellSupport.ui.entityListPage.search")}
                value={search ?? ""}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={t("catalog.support.shellSupport.ui.entityListPage.search.placeholder", { title: title.toLowerCase() })}
              />
            )}
            {onStatusFilterChange && statusOptions && (
              <Select
                label={t("catalog.support.shellSupport.ui.entityListPage.status")}
                value={statusFilter || ALL_STATUSES}
                onValueChange={(v) => onStatusFilterChange(v === ALL_STATUSES ? "" : v)}
                items={[{ label: t("catalog.support.shellSupport.ui.entityListPage.all.statuses"), value: ALL_STATUSES }, ...statusOptions]}
              />
            )}
            {extraFilters}
          </FilterBar>
        )}
        {error && <Banner tone="danger" title={t("catalog.support.shellSupport.ui.entityListPage.error")} description={error} />}
        {loading && !items ? (
          <LoadingSpinner label={t("catalog.support.shellSupport.ui.entityListPage.loading", { title: title.toLowerCase() })} />
        ) : items && items.length === 0 ? (
          <EmptyState
            title={t("catalog.support.shellSupport.ui.entityListPage.none.found", { title: title.toLowerCase() })}
            description={search || statusFilter ? t("catalog.support.shellSupport.ui.entityListPage.try.adjusting.your.filters") : t("catalog.support.shellSupport.ui.entityListPage.create.first", { entityName: entityName.toLowerCase() })}
            icon="package"
          />
        ) : items ? (
          <>
            <DataTable
              rows={items}
              columns={columnsWithView}
              getRowId={(row) => getRowId(row)}
              selectedKeys={selectedKeys}
              onSelectionChange={onSelectionChange}
              isRowSelectable={isRowSelectable}
              emptyTitle={t("catalog.support.shellSupport.ui.entityListPage.no.title", { title: title.toLowerCase() })}
            />
            {bulkActionBar}
            {showPagination && (
              <Inline gap={2} align="center">
                <Button
                  tone="secondary"
                  size="sm"
                  onClick={() => onPageChange?.(page - 1)}
                  disabled={page === 0}
                >
                  {t("catalog.support.shellSupport.ui.entityListPage.previous")}</Button>
                <span>{t("catalog.support.shellSupport.ui.entityListPage.page")}{page + 1} {t("catalog.support.shellSupport.ui.entityListPage.of")}{totalPages}</span>
                <Button
                  tone="secondary"
                  size="sm"
                  onClick={() => onPageChange?.(page + 1)}
                  disabled={page >= totalPages - 1}
                >
                  {t("catalog.support.shellSupport.ui.entityListPage.next")}</Button>
              </Inline>
            )}
          </>
        ) : null}
      </Stack>
    </Page>
  );
}
