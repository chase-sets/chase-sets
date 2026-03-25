import { useMemo, type ReactNode } from "react";
import {
  Button,
  DataTable,
  EmptyState,
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
        <LinkButton href={getHref(row)} size="sm" tone="secondary">
          View
        </LinkButton>
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
        {(onSearchChange || onStatusFilterChange) && (
          <Inline gap={3} align="start">
            {onSearchChange && (
              <TextInput
                label="Search"
                value={search ?? ""}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={`Search ${title.toLowerCase()}...`}
              />
            )}
            {onStatusFilterChange && statusOptions && (
              <Select
                label="Status"
                value={statusFilter || ALL_STATUSES}
                onValueChange={(v) => onStatusFilterChange(v === ALL_STATUSES ? "" : v)}
                items={[{ label: "All statuses", value: ALL_STATUSES }, ...statusOptions]}
              />
            )}
          </Inline>
        )}
        {error && <Banner tone="danger" title="Error" description={error} />}
        {loading && !items ? (
          <LoadingSpinner label={`Loading ${title.toLowerCase()}...`} />
        ) : items && items.length === 0 ? (
          <EmptyState
            title={`No ${title.toLowerCase()} found`}
            description={search || statusFilter ? "Try adjusting your filters." : `Create your first ${entityName.toLowerCase()} to get started.`}
            icon="package"
          />
        ) : items ? (
          <>
            <DataTable
              rows={items}
              columns={columnsWithView}
              getRowId={(row) => getRowId(row)}
              emptyTitle={`No ${title.toLowerCase()}`}
            />
            {showPagination && (
              <Inline gap={2} align="center">
                <Button
                  tone="secondary"
                  size="sm"
                  onClick={() => onPageChange?.(page - 1)}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <span>Page {page + 1} of {totalPages}</span>
                <Button
                  tone="secondary"
                  size="sm"
                  onClick={() => onPageChange?.(page + 1)}
                  disabled={page >= totalPages - 1}
                >
                  Next
                </Button>
              </Inline>
            )}
          </>
        ) : null}
      </Stack>
    </Page>
  );
}
