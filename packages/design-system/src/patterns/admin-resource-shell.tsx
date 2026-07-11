// Shared resource-list/resource-detail admin shell: the middle tier between raw DS primitives
// and the dense-admin-workbench pattern (which scopes itself to dense review queues). Bounded
// contexts wire their own filters, columns, and pagination navigation (see
// "@chase-sets/design-system/react-router"'s useAdminResourceListPageChange); this pattern owns
// only the presentational frame: header, filter slot, table, pager, and detail sections with
// loading/error/notFound handling.
import type { ReactNode } from "react";
import { Breadcrumbs, LinkButton, Pagination, type BreadcrumbItem } from "../components/actions";
import { ActionBar, Card, DataTable, type DataColumn } from "../components/data-display";
import { Banner, EmptyState, LoadingSpinner, StatusPill } from "../components/feedback";
import { Inline, Stack } from "../primitives/layout";
import { Text } from "../primitives/typography";
import { Page, PageHeader, PageSection } from "./app-shells/page-layouts";

export interface AdminResourceListPageProps<T> {
  title: ReactNode;
  /** Defaults to "{items.length} items"; pass a localized string to override. */
  itemCountLabel?: ReactNode;
  items: readonly T[];
  columns: readonly DataColumn<T>[];
  emptyMessage: ReactNode;
  getHref?: (row: T) => string;
  viewLabel?: string;
  actions?: ReactNode;
  filters?: ReactNode;
  pagination?: Readonly<{ limit: number; offset: number; total: number }>;
  onPageChange?: (page: number) => void;
}

export function AdminResourceListPage<T>({
  title,
  itemCountLabel,
  items,
  columns,
  emptyMessage,
  getHref,
  viewLabel = "View",
  actions,
  filters,
  pagination,
  onPageChange,
}: AdminResourceListPageProps<T>) {
  const pageSize = pagination?.limit ?? items.length;
  const currentPage = pagination && pageSize > 0 ? Math.floor(pagination.offset / pageSize) + 1 : 1;
  const totalPages = pagination && pageSize > 0 ? Math.max(1, Math.ceil(pagination.total / pageSize)) : 1;
  const showPagination = Boolean(pagination && (pagination.total > pageSize || pagination.offset > 0));

  const columnsWithView: readonly DataColumn<T>[] = getHref
    ? [
        ...columns,
        {
          key: "__view__",
          header: "",
          cell: (row) => (
            <LinkButton href={getHref(row)} size="sm" tone="secondary">
              {viewLabel}
            </LinkButton>
          ),
        },
      ]
    : columns;

  return (
    <Page>
      <PageHeader title={title} />
      <Stack gap={4}>
        {actions ? <ActionBar>{actions}</ActionBar> : null}
        {filters}
        <PageSection title={itemCountLabel ?? `${items.length} items`}>
          {items.length === 0 ? (
            <Text tone="secondary">{emptyMessage}</Text>
          ) : (
            <DataTable columns={[...columnsWithView]} rows={[...items]} />
          )}
          {showPagination ? (
            <Pagination page={currentPage} totalPages={totalPages} onPageChange={onPageChange} />
          ) : null}
        </PageSection>
      </Stack>
    </Page>
  );
}

export interface AdminResourceDetailSection {
  label: ReactNode;
  value: ReactNode;
}

export interface AdminResourceDetailPageProps {
  actions?: ReactNode;
  breadcrumbs?: readonly BreadcrumbItem[];
  error?: string | null;
  loading?: boolean;
  notFound?: boolean;
  notFoundDescription?: ReactNode;
  notFoundTitle?: ReactNode;
  loadingLabel?: string;
  errorTitle?: ReactNode;
  title: ReactNode;
  titleAside?: ReactNode;
  status?: string | null;
  sections: readonly AdminResourceDetailSection[];
}

export function AdminResourceDetailPage({
  actions,
  breadcrumbs,
  error = null,
  loading = false,
  notFound = false,
  notFoundDescription = "The requested record does not exist or is no longer available.",
  notFoundTitle = "Record not found",
  loadingLabel = "Loading record",
  errorTitle = "Unable to load record",
  title,
  titleAside,
  status,
  sections,
}: AdminResourceDetailPageProps) {
  return (
    <Page>
      {breadcrumbs && breadcrumbs.length > 0 ? <Breadcrumbs items={[...breadcrumbs]} /> : null}
      <PageHeader title={title} />
      <Stack gap={4}>
        {titleAside || status ? (
          <Inline align="center" gap={3}>
            {titleAside}
            {status ? <StatusPill>{status}</StatusPill> : null}
          </Inline>
        ) : null}
        {actions ? <ActionBar>{actions}</ActionBar> : null}
        {error ? <Banner tone="danger" title={errorTitle} description={error} /> : null}
        {loading ? (
          <LoadingSpinner label={loadingLabel} />
        ) : notFound ? (
          <EmptyState title={notFoundTitle} description={notFoundDescription} icon="search" />
        ) : (
          <Card>
            <Stack gap={3}>
              {sections.map((section, index) => (
                <Stack key={typeof section.label === "string" ? section.label : index} gap={1}>
                  <Text weight="semibold">{section.label}</Text>
                  {typeof section.value === "string" || typeof section.value === "number" ? (
                    <Text tone="secondary">{section.value}</Text>
                  ) : (
                    section.value
                  )}
                </Stack>
              ))}
            </Stack>
          </Card>
        )}
      </Stack>
    </Page>
  );
}
