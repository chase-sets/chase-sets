import { t } from "@chase-sets/localization";
import { Children, Fragment, isValidElement, useMemo, type ReactNode } from "react";
import {
  Button,
  ActionBar,
  BulkActionSurface,
  DataTable,
  EmptyState,
  FilterArea,
  LinkButton,
  LoadingSpinner,
  Page,
  PageHeader,
  Stack,
  Banner,
  TextInput,
  Select,
  Inline,
  Text,
  type DataColumn,
} from "@chase-sets/design-system";
import { toCatalogAdminHref } from "./catalog-admin-hrefs";

const ALL_STATUSES = "__all__";

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
  headerActions?: ReactNode;
  search?: string;
  onSearchChange?: (value: string) => void;
  statusFilter?: string;
  onStatusFilterChange?: (value: string) => void;
  statusOptions?: { label: string; value: string }[];
  extraFilters?: ReactNode;
  activeFilterCount?: number;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  isRowSelectable?: (row: T, index: number) => boolean;
  bulkActionBar?: ReactNode;
  realtimeReloadActionBar?: ReactNode;
  connectionStatus?: ReactNode;
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
  headerActions,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  statusOptions,
  extraFilters,
  activeFilterCount,
  selectedKeys,
  onSelectionChange,
  isRowSelectable,
  bulkActionBar,
  realtimeReloadActionBar,
  connectionStatus,
  page = 0,
  pageSize = 50,
  onPageChange,
}: EntityListPageProps<T>) {
  const totalPages = total !== undefined ? Math.ceil(total / pageSize) : 0;
  const showPagination = total !== undefined && total > pageSize;
  const filterControls: ReactNode[] = [];
  const resolvedActiveFilterCount = activeFilterCount ?? [search, statusFilter].filter(Boolean).length;

  const columnsWithView = useMemo<DataColumn<T>[]>(
    () => [
      ...columns,
      {
        key: "__view__",
        header: "",
        cell: (row) => (
          <LinkButton href={toCatalogAdminHref(getHref(row))} size="sm" tone="secondary">
            {t("catalog.support.shellSupport.ui.entityListPage.view")}
          </LinkButton>
        ),
      },
    ],
    [columns, getHref],
  );

  if (onSearchChange) {
    filterControls.push(
      <TextInput
        key="search"
        label={t("catalog.support.shellSupport.ui.entityListPage.search")}
        value={search ?? ""}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={t("catalog.support.shellSupport.ui.entityListPage.search.placeholder", {
          title: title.toLowerCase(),
        })}
      />,
    );
  }

  if (onStatusFilterChange && statusOptions) {
    filterControls.push(
      <Select
        key="status"
        label={t("catalog.support.shellSupport.ui.entityListPage.status")}
        value={statusFilter || ALL_STATUSES}
        onValueChange={(v) => onStatusFilterChange(v === ALL_STATUSES ? "" : v)}
        items={[
          { label: t("catalog.support.shellSupport.ui.entityListPage.all.statuses"), value: ALL_STATUSES },
          ...statusOptions,
        ]}
      />,
    );
  }

  filterControls.push(...flattenFilterControls(extraFilters));

  return (
    <Page>
      <PageHeader
        title={title}
        actions={
          connectionStatus || headerActions ? (
            <>
              {connectionStatus}
              {headerActions}
            </>
          ) : undefined
        }
      />
      <Stack gap={4}>
        {createButton ? <ActionBar>{createButton}</ActionBar> : null}
        {filterControls.length > 0 && (
          <FilterArea
            filters={filterControls}
            activeFilterCount={resolvedActiveFilterCount}
            panelTitle={t("catalog.support.shellSupport.ui.entityListPage.filters")}
            panelApplyLabel={t("catalog.support.shellSupport.ui.entityListPage.apply.filters")}
            panelCloseLabel={t("catalog.support.shellSupport.ui.entityListPage.close.filters")}
            overflowTriggerLabel={t("catalog.support.shellSupport.ui.entityListPage.more.filters")}
          />
        )}
        {error && (
          <Banner tone="danger" title={t("catalog.support.shellSupport.ui.entityListPage.error")} description={error} />
        )}
        {loading && !items ? (
          <LoadingSpinner
            label={t("catalog.support.shellSupport.ui.entityListPage.loading", { title: title.toLowerCase() })}
          />
        ) : items && items.length === 0 ? (
          <EmptyState
            title={t("catalog.support.shellSupport.ui.entityListPage.none.found", { title: title.toLowerCase() })}
            description={
              search || statusFilter
                ? t("catalog.support.shellSupport.ui.entityListPage.try.adjusting.your.filters")
                : t("catalog.support.shellSupport.ui.entityListPage.create.first", {
                    entityName: entityName.toLowerCase(),
                  })
            }
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
            {realtimeReloadActionBar || bulkActionBar ? (
              <BulkActionSurface>{realtimeReloadActionBar ?? bulkActionBar}</BulkActionSurface>
            ) : null}
            {showPagination && (
              <Inline gap={2} align="center">
                <Button tone="secondary" size="sm" onClick={() => onPageChange?.(page - 1)} disabled={page === 0}>
                  {t("catalog.support.shellSupport.ui.entityListPage.previous")}
                </Button>
                <Text element="span">
                  {t("catalog.support.shellSupport.ui.entityListPage.page")}
                  {page + 1} {t("catalog.support.shellSupport.ui.entityListPage.of")}
                  {totalPages}
                </Text>
                <Button
                  tone="secondary"
                  size="sm"
                  onClick={() => onPageChange?.(page + 1)}
                  disabled={page >= totalPages - 1}
                >
                  {t("catalog.support.shellSupport.ui.entityListPage.next")}
                </Button>
              </Inline>
            )}
          </>
        ) : null}
      </Stack>
    </Page>
  );
}

function flattenFilterControls(node: ReactNode): ReactNode[] {
  return Children.toArray(node).flatMap((child) => {
    if (isValidElement(child) && child.type === Fragment) {
      return flattenFilterControls((child.props as { children?: ReactNode }).children);
    }

    return [child];
  });
}
