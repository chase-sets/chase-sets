import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "./admin-pages";
import type { Session } from "./contracts";

const columns: DataColumn<Session>[] = [
  { key: "session_id", header: "Session", cell: (row) => row.session_id },
  { key: "user_id", header: "User", cell: (row) => row.user_id },
  { key: "account_id", header: "Account", cell: (row) => row.account_id },
  {
    key: "authentication_method",
    header: "Method",
    cell: (row) => row.authentication_method,
  },
  { key: "status", header: "Status", cell: (row) => row.status },
];

export function SessionListPage({
  initialData,
}: {
  initialData: { items: Session[] };
}) {
  return (
    <AdminListPage
      title="Sessions"
      items={initialData.items}
      columns={columns}
      emptyMessage="No sessions yet."
    />
  );
}
