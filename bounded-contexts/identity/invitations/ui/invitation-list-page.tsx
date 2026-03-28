import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../shell-support/ui/admin-pages";
import type { Invitation } from "./contracts";

const columns: DataColumn<Invitation>[] = [
  { key: "email", header: "Email", cell: (row) => row.email },
  { key: "account_id", header: "Account", cell: (row) => row.account_id },
  { key: "role_key", header: "Role", cell: (row) => row.role_key },
  { key: "status", header: "Status", cell: (row) => row.status },
];

export function InvitationListPage({
  initialData,
}: {
  initialData: { items: Invitation[] };
}) {
  return (
    <AdminListPage
      title="Invitations"
      items={initialData.items}
      columns={columns}
      emptyMessage="No invitations yet."
    />
  );
}
