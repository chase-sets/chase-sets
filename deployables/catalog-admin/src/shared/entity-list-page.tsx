import type { ReactNode } from "react";
import {
  Button,
  DataTable,
  EmptyState,
  LoadingSpinner,
  Page,
  PageHeader,
  Stack,
  Banner,
  type DataColumn,
} from "@chase-sets/design-system";
import { navigate } from "../router";

interface EntityListPageProps<T> {
  title: string;
  entityName: string;
  items: T[] | null;
  loading: boolean;
  error: string | null;
  columns: DataColumn<T>[];
  getRowId: (row: T) => string;
  getHref: (row: T) => string;
  createButton?: ReactNode;
}

export function EntityListPage<T>({
  title,
  entityName,
  items,
  loading,
  error,
  columns,
  getRowId,
  getHref,
  createButton,
}: EntityListPageProps<T>) {
  return (
    <Page>
      <PageHeader
        title={title}
        actions={createButton}
      />
      <Stack gap={4}>
        {error && <Banner tone="danger" title="Error" description={error} />}
        {loading && !items ? (
          <LoadingSpinner label={`Loading ${title.toLowerCase()}...`} />
        ) : items && items.length === 0 ? (
          <EmptyState
            title={`No ${title.toLowerCase()} yet`}
            description={`Create your first ${entityName.toLowerCase()} to get started.`}
            icon="package"
          />
        ) : items ? (
          <DataTable
            rows={items}
            columns={columns}
            getRowId={(row, index) => getRowId(row)}
            emptyTitle={`No ${title.toLowerCase()}`}
          />
        ) : null}
      </Stack>
    </Page>
  );
}
