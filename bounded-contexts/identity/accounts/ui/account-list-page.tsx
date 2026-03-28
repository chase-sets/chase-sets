import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../shell-support/ui/admin-pages";
import type { Account } from "./contracts";

const columns: DataColumn<Account>[] = [
  { key: "display_name", header: "Display Name", cell: (row) => row.display_name },
  { key: "name", header: "Legal Name", cell: (row) => row.name },
  { key: "account_type", header: "Type", cell: (row) => row.account_type },
  { key: "status", header: "Status", cell: (row) => row.status },
];

export function AccountListPage({
  initialData,
}: {
  initialData: { items: Account[] };
}) {
  return (
    <AdminListPage
      title="Accounts"
      items={initialData.items}
      columns={columns}
      emptyMessage="No accounts yet."
    />
  );
}
