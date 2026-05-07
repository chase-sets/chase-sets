import { t } from "@chase-sets/localization";
import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../../support/shell-support/ui/admin-pages";
import type { Account } from "./contracts";

const columns: DataColumn<Account>[] = [
  { key: "display_name", header: t("identity.features.accounts.ui.accountListPage.display.name"), cell: (row) => row.display_name },
  { key: "name", header: t("identity.features.accounts.ui.accountListPage.legal.name"), cell: (row) => row.name },
  { key: "account_type", header: t("identity.features.accounts.ui.accountListPage.type"), cell: (row) => row.account_type },
  { key: "status", header: t("identity.features.accounts.ui.accountListPage.status"), cell: (row) => row.status },
];

export function AccountListPage({
  initialData,
}: {
  initialData: { items: Account[] };
}) {
  return (
    <AdminListPage
      title={t("identity.features.accounts.ui.accountListPage.accounts")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("identity.features.accounts.ui.accountListPage.no.accounts.yet")}
      getHref={(row) => `/identity/accounts/${row.account_id}`}
    />
  );
}
