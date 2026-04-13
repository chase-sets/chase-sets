import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../../support/shell-support/ui/admin-pages";
import type { User } from "./contracts";

const columns: DataColumn<User>[] = [
  { key: "display_name", header: "Display Name", cell: (row) => row.display_name },
  { key: "primary_email", header: "Email", cell: (row) => row.primary_email },
  {
    key: "auth_methods",
    header: "Auth Methods",
    cell: (row) => row.auth_methods.join(", ") || "None",
  },
  { key: "status", header: "Status", cell: (row) => row.status },
];

export function UserListPage({ initialData }: { initialData: { items: User[] } }) {
  return (
    <AdminListPage
      title="Users"
      items={initialData.items}
      columns={columns}
      emptyMessage="No users yet."
    />
  );
}
