import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../shell-support/ui/admin-pages";
import type { ApiKey } from "./contracts";

const columns: DataColumn<ApiKey>[] = [
  { key: "name", header: "Name", cell: (row) => row.name },
  { key: "user_id", header: "User", cell: (row) => row.user_id },
  { key: "key_prefix", header: "Prefix", cell: (row) => row.key_prefix },
  { key: "status", header: "Status", cell: (row) => row.status },
];

export function ApiKeyListPage({
  initialData,
}: {
  initialData: { items: ApiKey[] };
}) {
  return (
    <AdminListPage
      title="API Keys"
      items={initialData.items}
      columns={columns}
      emptyMessage="No API keys yet."
    />
  );
}
