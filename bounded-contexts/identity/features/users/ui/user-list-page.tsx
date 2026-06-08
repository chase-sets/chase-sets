import { t } from "@chase-sets/localization";
import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../../support/shell-support/ui/admin-pages";
import type { User } from "./contracts";

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

export function UserListPage({ initialData }: { initialData: { items: User[] } }) {
  return (
    <AdminListPage
      title={t("identity.features.users.ui.userListPage.users")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("identity.features.users.ui.userListPage.no.users.yet")}
      getHref={(row) => `/access/users/${row.user_id}`}
    />
  );
}
