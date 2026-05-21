import { t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  ActionBar,
  Card,
  DataTable,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  StatusPill,
  Text,
  type DataColumn,
} from "@chase-sets/design-system";

export function AdminListPage<T>({
  title,
  items,
  columns,
  emptyMessage,
  getHref,
  actions,
}: {
  title: string;
  items: readonly T[];
  columns: readonly DataColumn<T>[];
  emptyMessage: string;
  getHref?: (row: T) => string;
  actions?: ReactNode;
}) {
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
        </PageSection>
      </Stack>
    </Page>
  );
}

export function AdminDetailPage({
  actions,
  title,
  status,
  sections,
}: {
  actions?: ReactNode;
  title: ReactNode;
  status?: string | null;
  sections: readonly { label: string; value: string }[];
}) {
  return (
    <Stack gap={4}>
      <Stack direction="row" align="center" justify="between" gap={3}>
        <Stack direction="row" align="center" gap={3}>
          <Text element="div" size="lg" weight="semibold">
            {title}
          </Text>
          {status ? <StatusPill>{status}</StatusPill> : null}
        </Stack>
        {actions ? <ActionBar>{actions}</ActionBar> : null}
      </Stack>
      <Card>
        <Stack gap={3}>
          {sections.map((section) => (
            <Stack key={section.label} gap={1}>
              <Text weight="semibold">{section.label}</Text>
              <Text tone="secondary">{section.value}</Text>
            </Stack>
          ))}
        </Stack>
      </Card>
    </Stack>
  );
}
