import { t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  ActionBar,
  Banner,
  Breadcrumbs,
  Card,
  DataTable,
  EmptyState,
  Inline,
  LinkButton,
  LoadingSpinner,
  Page,
  PageHeader,
  PageSection,
  Pagination,
  Stack,
  StatusPill,
  Text,
  type BreadcrumbItem,
  type DataColumn,
} from "@chase-sets/design-system";

export function AdminListPage<T>({
  title,
  items,
  columns,
  emptyMessage,
  getHref,
  actions,
  filters,
  pagination,
}: {
  title: string;
  items: readonly T[];
  columns: readonly DataColumn<T>[];
  emptyMessage: string;
  getHref?: (row: T) => string;
  actions?: ReactNode;
  filters?: ReactNode;
  pagination?: Readonly<{ limit: number; offset: number; total: number }>;
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

  const columnsWithView: readonly DataColumn<T>[] = getHref
    ? [
        ...columns,
        {
          key: "__view__",
          header: "",
          cell: (row) => (
            <LinkButton href={getHref(row)} size="sm" tone="secondary">
              {t("identity.support.shellSupport.ui.adminPages.view")}
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
        <PageSection
          title={t("identity.support.shellSupport.ui.adminPages.item.count", {
            count: items.length,
          })}
        >
          {items.length === 0 ? (
            <Text tone="secondary">{emptyMessage}</Text>
          ) : (
            <DataTable columns={[...columnsWithView]} rows={[...items]} />
          )}
          {showPagination ? (
            <Pagination page={currentPage} totalPages={totalPages} onPageChange={navigateToPage} />
          ) : null}
        </PageSection>
      </Stack>
    </Page>
  );
}

export function AdminDetailPage({
  actions,
  breadcrumbs,
  error = null,
  loading = false,
  notFound = false,
  notFoundDescription = t(
    "identity.support.shellSupport.ui.adminPages.the.requested.identity.record.does.not.exist.or.is.no.longer.available",
  ),
  notFoundTitle = t("identity.support.shellSupport.ui.adminPages.identity.record.not.found"),
  title,
  titleAside,
  status,
  sections,
}: {
  actions?: ReactNode;
  breadcrumbs?: readonly BreadcrumbItem[];
  error?: string | null;
  loading?: boolean;
  notFound?: boolean;
  notFoundDescription?: string;
  notFoundTitle?: string;
  title: ReactNode;
  titleAside?: ReactNode;
  status?: string | null;
  sections: readonly { label: string; value: ReactNode }[];
}) {
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
        {error ? (
          <Banner
            tone="danger"
            title={t("identity.support.shellSupport.ui.adminPages.unable.to.load.identity.record")}
            description={error}
          />
        ) : null}
        {loading ? (
          <LoadingSpinner label={t("identity.support.shellSupport.ui.adminPages.loading.identity.record")} />
        ) : notFound ? (
          <EmptyState title={notFoundTitle} description={notFoundDescription} icon="search" />
        ) : (
          <Card>
            <Stack gap={3}>
              {sections.map((section) => (
                <Stack key={section.label} gap={1}>
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
