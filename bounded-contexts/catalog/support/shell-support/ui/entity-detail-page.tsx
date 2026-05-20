import { t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  ActionBar,
  Banner,
  Breadcrumbs,
  EmptyState,
  LoadingSpinner,
  Page,
  PageHeader,
  Stack,
  type BreadcrumbItem,
} from "@chase-sets/design-system";

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

function toCatalogAdminBreadcrumbs(items: BreadcrumbItem[]) {
  return items.map((item) => ({
    ...item,
    href: item.href ? toCatalogAdminHref(item.href) : item.href,
  }));
}

interface EntityDetailPageProps {
  title: string;
  breadcrumbs: BreadcrumbItem[];
  actions?: ReactNode;
  loading: boolean;
  notFound: boolean;
  error: string | null;
  children: ReactNode;
}

export function EntityDetailPage({
  title,
  breadcrumbs,
  actions,
  loading,
  notFound,
  error,
  children,
}: EntityDetailPageProps) {
  return (
    <Page>
      <Breadcrumbs items={toCatalogAdminBreadcrumbs(breadcrumbs)} />
      <PageHeader title={title} />
      <Stack gap={4}>
        {actions ? <ActionBar>{actions}</ActionBar> : null}
        {error && <Banner tone="danger" title={t("catalog.support.shellSupport.ui.entityDetailPage.error")} description={error} />}
        {loading ? (
          <LoadingSpinner label={t("catalog.support.shellSupport.ui.entityDetailPage.loading")} />
        ) : notFound ? (
          <EmptyState title={t("catalog.support.shellSupport.ui.entityDetailPage.not.found")} description={t("catalog.support.shellSupport.ui.entityDetailPage.the.requested.item.does.not.exist")} icon="search" />
        ) : (
          children
        )}
      </Stack>
    </Page>
  );
}
