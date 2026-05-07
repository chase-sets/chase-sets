import { t } from "@chase-sets/localization";
import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../../support/shell-support/ui/admin-pages";
import type { ApiKey } from "./contracts";

const columns: DataColumn<ApiKey>[] = [
  { key: "name", header: t("identity.features.apiKeys.ui.apiKeyListPage.name"), cell: (row) => row.name },
  { key: "user_id", header: t("identity.features.apiKeys.ui.apiKeyListPage.user"), cell: (row) => row.user_id },
  { key: "key_prefix", header: t("identity.features.apiKeys.ui.apiKeyListPage.prefix"), cell: (row) => row.key_prefix },
  { key: "status", header: t("identity.features.apiKeys.ui.apiKeyListPage.status"), cell: (row) => row.status },
];

export function ApiKeyListPage({
  initialData,
}: {
  initialData: { items: ApiKey[] };
}) {
  return (
    <AdminListPage
      title={t("identity.features.apiKeys.ui.apiKeyListPage.api.keys")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("identity.features.apiKeys.ui.apiKeyListPage.no.api.keys.yet")}
      getHref={(row) => `/identity/api-keys/${row.api_key_id}`}
    />
  );
}
