import { t } from "@chase-sets/localization";
import {
  AdminResourceListPage,
  AppliedFilterChips,
  HiddenInput,
  Form,
  Inline,
  FilterArea,
  Button,
  LinkButton,
  NativeSelect,
  Stack,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useAdminResourceListPageChange } from "@chase-sets/design-system/react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { IDENTITY_INVITATION_STATUSES, type IdentityListFilters } from "../../../support/route-support/list-filters";
import { grantableRoleSelectItems } from "../../memberships/ui/role-select-items";
import type { Account } from "../../accounts/ui/contracts";
import type { Invitation } from "./contracts";
import { invitationStatusLabel, membershipRoleLabel } from "../../../support/ui-support/value-labels";

type PaginatedListResponse<T> = ListResponse<T> & Readonly<{ limit: number; offset: number }>;

function accountLabel(invitation: Invitation) {
  return invitation.account_display_name ?? invitation.account_name ?? invitation.account_id;
}

function accountPickerLabel(account: Account) {
  const label = account.display_name || account.name || account.account_id;
  return label === account.account_id ? label : `${label} (${account.account_id})`;
}

const columns: DataColumn<Invitation>[] = [
  { key: "email", header: t("identity.features.invitations.ui.invitationListPage.email"), cell: (row) => row.email },
  {
    key: "account_id",
    header: t("identity.features.invitations.ui.invitationListPage.account"),
    cell: accountLabel,
  },
  {
    key: "role_key",
    header: t("identity.features.invitations.ui.invitationListPage.role"),
    cell: (row) => membershipRoleLabel(row.role_key),
  },
  {
    key: "status",
    header: t("identity.features.invitations.ui.invitationListPage.status"),
    cell: (row) => invitationStatusLabel(row.status),
  },
];

function invitationStatusFilterLabel(status: string) {
  return status === "all"
    ? t("identity.features.invitations.ui.invitationListPage.status.filter.all")
    : invitationStatusLabel(status);
}

function invitationStatusFilterItems() {
  return [
    { value: "all", label: invitationStatusFilterLabel("all") },
    ...IDENTITY_INVITATION_STATUSES.map((status) => ({ value: status, label: invitationStatusFilterLabel(status) })),
  ];
}

function buildInvitationAppliedFilters(filters: IdentityListFilters) {
  const applied: { id: string; label: string }[] = [];
  if (filters.search) {
    applied.push({
      id: "search",
      label: t("identity.features.invitations.ui.invitationListPage.search.filter.chip", { search: filters.search }),
    });
  }
  if (filters.status !== "all") {
    applied.push({
      id: "status",
      label: t("identity.features.invitations.ui.invitationListPage.status.filter.chip", {
        status: invitationStatusFilterLabel(filters.status),
      }),
    });
  }

  return applied;
}

export function InvitationListPage({
  accounts,
  initialData,
  filters = { status: "all", search: "" },
}: {
  accounts: readonly Account[];
  initialData: PaginatedListResponse<Invitation>;
  filters?: IdentityListFilters;
}) {
  const accountSelectItems = accounts.map((account) => ({
    value: account.account_id,
    label: accountPickerLabel(account),
  }));
  const hasAccounts = accountSelectItems.length > 0;
  const appliedFilters = buildInvitationAppliedFilters(filters);
  const onPageChange = useAdminResourceListPageChange(initialData);

  return (
    <AdminResourceListPage
      title={t("identity.features.invitations.ui.invitationListPage.invitations")}
      items={initialData.items}
      columns={columns}
      actions={
        <Form spacing="none" method="post">
          <Stack direction="row" align="end" gap={2}>
            <HiddenInput type="hidden" name="intent" value="create" readOnly />
            <NativeSelect
              name="accountId"
              label={t("identity.features.invitations.ui.invitationListPage.account")}
              placeholder={t("identity.features.invitations.ui.invitationListPage.select.account")}
              items={accountSelectItems}
              required
              disabled={!hasAccounts}
            />
            <TextInput
              name="email"
              label={t("identity.features.invitations.ui.invitationListPage.email")}
              type="email"
              required
            />
            <NativeSelect
              name="roleKey"
              label={t("identity.features.invitations.ui.invitationListPage.role")}
              defaultValue="viewer"
              items={grantableRoleSelectItems}
            />
            <Button type="submit" tone="primary" disabled={!hasAccounts}>
              {t("identity.features.invitations.ui.invitationListPage.create")}
            </Button>
          </Stack>
        </Form>
      }
      filters={
        <>
          <Form method="get" spacing="none">
            <FilterArea
              activeFilterCount={appliedFilters.length}
              primaryFilterCount={2}
              panelTitle={t("identity.features.invitations.ui.invitationListPage.filters")}
              overflowTriggerLabel={t("identity.features.invitations.ui.invitationListPage.more.filters")}
              filters={[
                <TextInput
                  key="search"
                  label={t("identity.features.invitations.ui.invitationListPage.search")}
                  name="search"
                  defaultValue={filters.search}
                  placeholder={t("identity.features.invitations.ui.invitationListPage.search.placeholder")}
                />,
                <NativeSelect
                  key="status"
                  label={t("identity.features.invitations.ui.invitationListPage.status")}
                  name="status"
                  defaultValue={filters.status}
                  items={invitationStatusFilterItems()}
                />,
              ]}
              actions={
                <Inline>
                  <Button type="submit" leadingIcon="filter">
                    {t("identity.features.invitations.ui.invitationListPage.apply.filters")}
                  </Button>
                  <LinkButton href="/access/invitations" tone="secondary">
                    {t("identity.features.invitations.ui.invitationListPage.clear.filters")}
                  </LinkButton>
                </Inline>
              }
            />
          </Form>
          <AppliedFilterChips
            filters={appliedFilters}
            clearAction={
              appliedFilters.length > 0 ? (
                <LinkButton href="/access/invitations" size="sm" tone="secondary">
                  {t("identity.features.invitations.ui.invitationListPage.clear.filters")}
                </LinkButton>
              ) : null
            }
          />
        </>
      }
      emptyMessage={t("identity.features.invitations.ui.invitationListPage.no.invitations.yet")}
      getHref={(row) =>
        `/access/accounts/${row.account_id}?tab=team&invitation=${encodeURIComponent(row.invitation_id)}`
      }
      pagination={initialData}
      onPageChange={onPageChange}
    />
  );
}
