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
import { IDENTITY_MEMBERSHIP_STATUSES, type IdentityListFilters } from "../../../support/route-support/list-filters";
import type { Membership } from "./contracts";

type PaginatedListResponse<T> = ListResponse<T> & Readonly<{ limit: number; offset: number }>;

function userLabel(membership: Membership) {
  return membership.user_display_name ?? membership.user_primary_email ?? membership.user_id;
}

function accountLabel(membership: Membership) {
  return membership.account_display_name ?? membership.account_name ?? membership.account_id;
}

const columns: DataColumn<Membership>[] = [
  { key: "user_id", header: t("identity.features.memberships.ui.membershipListPage.user"), cell: userLabel },
  {
    key: "account_id",
    header: t("identity.features.memberships.ui.membershipListPage.account"),
    cell: accountLabel,
  },
  {
    key: "role_key",
    header: t("identity.features.memberships.ui.membershipListPage.role"),
    cell: (row) => row.role_key,
  },
  { key: "status", header: t("identity.features.memberships.ui.membershipListPage.status"), cell: (row) => row.status },
];

function membershipStatusFilterLabel(status: string) {
  switch (status) {
    case "active":
      return t("identity.features.memberships.ui.membershipListPage.status.filter.active");
    case "revoked":
      return t("identity.features.memberships.ui.membershipListPage.status.filter.revoked");
    default:
      return t("identity.features.memberships.ui.membershipListPage.status.filter.all");
  }
}

function membershipStatusFilterItems() {
  return [
    { value: "all", label: membershipStatusFilterLabel("all") },
    ...IDENTITY_MEMBERSHIP_STATUSES.map((status) => ({ value: status, label: membershipStatusFilterLabel(status) })),
  ];
}

function buildMembershipAppliedFilters(filters: IdentityListFilters) {
  const applied: { id: string; label: string }[] = [];
  if (filters.search) {
    applied.push({
      id: "search",
      label: t("identity.features.memberships.ui.membershipListPage.search.filter.chip", { search: filters.search }),
    });
  }
  if (filters.status !== "all") {
    applied.push({
      id: "status",
      label: t("identity.features.memberships.ui.membershipListPage.status.filter.chip", {
        status: membershipStatusFilterLabel(filters.status),
      }),
    });
  }

  return applied;
}

export function MembershipListPage({
  initialData,
  filters = { status: "all", search: "" },
}: {
  initialData: PaginatedListResponse<Membership>;
  filters?: IdentityListFilters;
}) {
  const appliedFilters = buildMembershipAppliedFilters(filters);

  return (
    <AdminListPage
      title={t("identity.features.memberships.ui.membershipListPage.memberships")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("identity.features.memberships.ui.membershipListPage.no.memberships.yet")}
      getHref={(row) => `/access/memberships/${row.membership_id}`}
      filters={
        <>
          <Form method="get" spacing="none">
            <FilterArea
              activeFilterCount={appliedFilters.length}
              primaryFilterCount={2}
              panelTitle={t("identity.features.memberships.ui.membershipListPage.filters")}
              overflowTriggerLabel={t("identity.features.memberships.ui.membershipListPage.more.filters")}
              filters={[
                <TextInput
                  key="search"
                  label={t("identity.features.memberships.ui.membershipListPage.search")}
                  name="search"
                  defaultValue={filters.search}
                  placeholder={t("identity.features.memberships.ui.membershipListPage.search.placeholder")}
                />,
                <NativeSelect
                  key="status"
                  label={t("identity.features.memberships.ui.membershipListPage.status")}
                  name="status"
                  defaultValue={filters.status}
                  items={membershipStatusFilterItems()}
                />,
              ]}
              actions={
                <Inline>
                  <Button type="submit" leadingIcon="filter">
                    {t("identity.features.memberships.ui.membershipListPage.apply.filters")}
                  </Button>
                  <LinkButton href="/access/memberships" tone="secondary">
                    {t("identity.features.memberships.ui.membershipListPage.clear.filters")}
                  </LinkButton>
                </Inline>
              }
            />
          </Form>
          <AppliedFilterChips
            filters={appliedFilters}
            clearAction={
              appliedFilters.length > 0 ? (
                <LinkButton href="/access/memberships" size="sm" tone="secondary">
                  {t("identity.features.memberships.ui.membershipListPage.clear.filters")}
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
