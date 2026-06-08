import { t } from "@chase-sets/localization";
import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../../support/shell-support/ui/admin-pages";
import type { Membership } from "./contracts";

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

export function MembershipListPage({ initialData }: { initialData: { items: Membership[] } }) {
  return (
    <AdminListPage
      title={t("identity.features.memberships.ui.membershipListPage.memberships")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("identity.features.memberships.ui.membershipListPage.no.memberships.yet")}
      getHref={(row) => `/access/memberships/${row.membership_id}`}
    />
  );
}
