import { t } from "@chase-sets/localization";
import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../../support/shell-support/ui/admin-pages";
import type { Membership } from "./contracts";

const columns: DataColumn<Membership>[] = [
  { key: "membership_id", header: t("identity.features.memberships.ui.membershipListPage.membership.id"), cell: (row) => row.membership_id },
  { key: "user_id", header: t("identity.features.memberships.ui.membershipListPage.user"), cell: (row) => row.user_id },
  { key: "account_id", header: t("identity.features.memberships.ui.membershipListPage.account"), cell: (row) => row.account_id },
  { key: "role_key", header: t("identity.features.memberships.ui.membershipListPage.role"), cell: (row) => row.role_key },
  { key: "status", header: t("identity.features.memberships.ui.membershipListPage.status"), cell: (row) => row.status },
];

export function MembershipListPage({
  initialData,
}: {
  initialData: { items: Membership[] };
}) {
  return (
    <AdminListPage
      title={t("identity.features.memberships.ui.membershipListPage.memberships")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("identity.features.memberships.ui.membershipListPage.no.memberships.yet")}
      getHref={(row) => `/identity/memberships/${row.membership_id}`}
    />
  );
}
