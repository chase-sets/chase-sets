import { t } from "@chase-sets/localization";
import {
  AdminResourceListPage,
  AppliedFilterChips,
  Form,
  Inline,
  FilterArea,
  Button,
  LinkButton,
  NativeSelect,
  Text,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useAdminResourceListPageChange } from "@chase-sets/design-system/react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { IDENTITY_ACCOUNT_STATUSES, type IdentityListFilters } from "../../../support/route-support/list-filters";
import { AccountBadgeList } from "./account-badges";
import type { Account } from "./contracts";

type PaginatedListResponse<T> = ListResponse<T> & Readonly<{ limit: number; offset: number }>;

const columns: DataColumn<Account>[] = [
  {
    key: "display_name",
    header: t("identity.features.accounts.ui.accountListPage.display.name"),
    cell: (row) => (
      <Inline gap={2}>
        <Text element="span">{row.display_name}</Text>
        <AccountBadgeList badges={row.badges} founderNumber={row.founder_number} compact />
      </Inline>
    ),
  },
  { key: "name", header: t("identity.features.accounts.ui.accountListPage.legal.name"), cell: (row) => row.name },
  {
    key: "account_type",
    header: t("identity.features.accounts.ui.accountListPage.type"),
    cell: (row) => row.account_type,
  },
  { key: "status", header: t("identity.features.accounts.ui.accountListPage.status"), cell: (row) => row.status },
];

function accountStatusFilterLabel(status: string) {
  switch (status) {
    case "active":
      return t("identity.features.accounts.ui.accountListPage.status.filter.active");
    case "suspended":
      return t("identity.features.accounts.ui.accountListPage.status.filter.suspended");
    case "closed":
      return t("identity.features.accounts.ui.accountListPage.status.filter.closed");
    default:
      return t("identity.features.accounts.ui.accountListPage.status.filter.all");
  }
}

function accountStatusFilterItems() {
  return [
    { value: "all", label: accountStatusFilterLabel("all") },
    ...IDENTITY_ACCOUNT_STATUSES.map((status) => ({ value: status, label: accountStatusFilterLabel(status) })),
  ];
}

function buildAccountAppliedFilters(filters: IdentityListFilters) {
  const applied: { id: string; label: string }[] = [];
  if (filters.search) {
    applied.push({
      id: "search",
      label: t("identity.features.accounts.ui.accountListPage.search.filter.chip", { search: filters.search }),
    });
  }
  if (filters.status !== "all") {
    applied.push({
      id: "status",
      label: t("identity.features.accounts.ui.accountListPage.status.filter.chip", {
        status: accountStatusFilterLabel(filters.status),
      }),
    });
  }

  return applied;
}

export function AccountListPage({
  initialData,
  filters = { status: "all", search: "" },
}: {
  initialData: PaginatedListResponse<Account>;
  filters?: IdentityListFilters;
}) {
  const appliedFilters = buildAccountAppliedFilters(filters);
  const onPageChange = useAdminResourceListPageChange(initialData);

  return (
    <AdminResourceListPage
      title={t("identity.features.accounts.ui.accountListPage.accounts")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("identity.features.accounts.ui.accountListPage.no.accounts.yet")}
      getHref={(row) => `/access/accounts/${row.account_id}`}
      filters={
        <>
          <Form method="get" spacing="none">
            <FilterArea
              activeFilterCount={appliedFilters.length}
              primaryFilterCount={2}
              panelTitle={t("identity.features.accounts.ui.accountListPage.filters")}
              overflowTriggerLabel={t("identity.features.accounts.ui.accountListPage.more.filters")}
              filters={[
                <TextInput
                  key="search"
                  label={t("identity.features.accounts.ui.accountListPage.search")}
                  name="search"
                  defaultValue={filters.search}
                  placeholder={t("identity.features.accounts.ui.accountListPage.search.placeholder")}
                />,
                <NativeSelect
                  key="status"
                  label={t("identity.features.accounts.ui.accountListPage.status")}
                  name="status"
                  defaultValue={filters.status}
                  items={accountStatusFilterItems()}
                />,
              ]}
              actions={
                <Inline>
                  <Button type="submit" leadingIcon="filter">
                    {t("identity.features.accounts.ui.accountListPage.apply.filters")}
                  </Button>
                  <LinkButton href="/access/accounts" tone="secondary">
                    {t("identity.features.accounts.ui.accountListPage.clear.filters")}
                  </LinkButton>
                </Inline>
              }
            />
          </Form>
          <AppliedFilterChips
            filters={appliedFilters}
            clearAction={
              appliedFilters.length > 0 ? (
                <LinkButton href="/access/accounts" size="sm" tone="secondary">
                  {t("identity.features.accounts.ui.accountListPage.clear.filters")}
                </LinkButton>
              ) : null
            }
          />
        </>
      }
      pagination={initialData}
      onPageChange={onPageChange}
    />
  );
}
