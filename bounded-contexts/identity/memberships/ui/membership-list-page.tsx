import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../shell-support/ui/admin-pages";
import type { Membership } from "./contracts";

const columns: DataColumn<Membership>[] = [
  { key: "membership_id", header: "Membership ID", cell: (row) => row.membership_id },
  { key: "user_id", header: "User", cell: (row) => row.user_id },
  { key: "account_id", header: "Account", cell: (row) => row.account_id },
  { key: "role_key", header: "Role", cell: (row) => row.role_key },
  { key: "status", header: "Status", cell: (row) => row.status },
];

export function MembershipListPage({
  initialData,
}: {
  initialData: { items: Membership[] };
}) {
  return (
    <AdminListPage
      title="Memberships"
      items={initialData.items}
      columns={columns}
      emptyMessage="No memberships yet."
    />
  );
}
