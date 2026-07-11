import { t } from "@chase-sets/localization";
import {
  AppliedFilterChips,
  Form,
  Inline,
  FilterArea,
  Button,
  LinkButton,
  NativeSelect,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import type { ListResponse } from "@chase-sets/http/responses";
import { AdminListPage } from "../../../support/shell-support/ui/admin-pages";
import { IDENTITY_USER_STATUSES, type IdentityListFilters } from "../../../support/route-support/list-filters";
import type { User } from "./contracts";

type PaginatedListResponse<T> = ListResponse<T> & Readonly<{ limit: number; offset: number }>;

const columns: DataColumn<User>[] = [
  {
    key: "display_name",
    header: t("identity.features.users.ui.userListPage.display.name"),
    cell: (row) => row.display_name,
  },
  {
    key: "primary_email",
    header: t("identity.features.users.ui.userListPage.email"),
    cell: (row) => row.primary_email,
  },
  {
    key: "auth_methods",
    header: t("identity.features.users.ui.userListPage.auth.methods"),
    cell: (row) => row.auth_methods.join(", ") || t("identity.features.users.ui.userListPage.none"),
  },
  { key: "status", header: t("identity.features.users.ui.userListPage.status"), cell: (row) => row.status },
];

function userStatusFilterLabel(status: string) {
  switch (status) {
    case "active":
      return t("identity.features.users.ui.userListPage.status.filter.active");
    case "suspended":
      return t("identity.features.users.ui.userListPage.status.filter.suspended");
    default:
      return t("identity.features.users.ui.userListPage.status.filter.all");
  }
}

function userStatusFilterItems() {
  return [
    { value: "all", label: userStatusFilterLabel("all") },
    ...IDENTITY_USER_STATUSES.map((status) => ({ value: status, label: userStatusFilterLabel(status) })),
  ];
}

function buildUserAppliedFilters(filters: IdentityListFilters) {
  const applied: { id: string; label: string }[] = [];
  if (filters.search) {
    applied.push({
      id: "search",
      label: t("identity.features.users.ui.userListPage.search.filter.chip", { search: filters.search }),
    });
  }
  if (filters.status !== "all") {
    applied.push({
      id: "status",
      label: t("identity.features.users.ui.userListPage.status.filter.chip", {
        status: userStatusFilterLabel(filters.status),
      }),
    });
  }

  return applied;
}

export function UserListPage({
  initialData,
  filters = { status: "all", search: "" },
}: {
  initialData: PaginatedListResponse<User>;
  filters?: IdentityListFilters;
}) {
  const appliedFilters = buildUserAppliedFilters(filters);

  return (
    <AdminListPage
      title={t("identity.features.users.ui.userListPage.users")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("identity.features.users.ui.userListPage.no.users.yet")}
      getHref={(row) => `/access/users/${row.user_id}`}
      filters={
        <>
          <Form method="get" spacing="none">
            <FilterArea
              activeFilterCount={appliedFilters.length}
              primaryFilterCount={2}
              panelTitle={t("identity.features.users.ui.userListPage.filters")}
              overflowTriggerLabel={t("identity.features.users.ui.userListPage.more.filters")}
              filters={[
                <TextInput
                  key="search"
                  label={t("identity.features.users.ui.userListPage.search")}
                  name="search"
                  defaultValue={filters.search}
                  placeholder={t("identity.features.users.ui.userListPage.search.placeholder")}
                />,
                <NativeSelect
                  key="status"
                  label={t("identity.features.users.ui.userListPage.status")}
                  name="status"
                  defaultValue={filters.status}
                  items={userStatusFilterItems()}
                />,
              ]}
              actions={
                <Inline>
                  <Button type="submit" leadingIcon="filter">
                    {t("identity.features.users.ui.userListPage.apply.filters")}
                  </Button>
                  <LinkButton href="/access/users" tone="secondary">
                    {t("identity.features.users.ui.userListPage.clear.filters")}
                  </LinkButton>
                </Inline>
              }
            />
          </Form>
          <AppliedFilterChips
            filters={appliedFilters}
            clearAction={
              appliedFilters.length > 0 ? (
                <LinkButton href="/access/users" size="sm" tone="secondary">
                  {t("identity.features.users.ui.userListPage.clear.filters")}
                </LinkButton>
              ) : null
            }
          />
        </>
      }
      pagination={initialData}
    />
  );
}
