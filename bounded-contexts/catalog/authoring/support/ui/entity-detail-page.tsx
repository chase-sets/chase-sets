import type { ReactNode } from "react";
import {
  Banner,
  Breadcrumbs,
  EmptyState,
  LoadingSpinner,
  Page,
  PageHeader,
  Stack,
  type BreadcrumbItem,
} from "@chase-sets/design-system";

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
      <Breadcrumbs items={breadcrumbs} />
      <PageHeader title={title} actions={actions} />
      <Stack gap={4}>
        {error && <Banner tone="danger" title="Error" description={error} />}
        {loading ? (
          <LoadingSpinner label="Loading..." />
        ) : notFound ? (
          <EmptyState title="Not found" description="The requested item does not exist." icon="search" />
        ) : (
          children
        )}
      </Stack>
    </Page>
  );
}

