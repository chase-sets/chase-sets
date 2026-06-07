import { t } from "@chase-sets/localization";
import { Form, Button, Stack, TextInput, type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../../support/shell-support/ui/admin-pages";
import type { ApiKey } from "./contracts";

function userLabel(apiKey: ApiKey) {
  return apiKey.user_display_name ?? apiKey.user_primary_email ?? apiKey.user_id;
}

const columns: DataColumn<ApiKey>[] = [
  { key: "name", header: t("identity.features.apiKeys.ui.apiKeyListPage.name"), cell: (row) => row.name },
  { key: "user_id", header: t("identity.features.apiKeys.ui.apiKeyListPage.user"), cell: userLabel },
  { key: "key_prefix", header: t("identity.features.apiKeys.ui.apiKeyListPage.prefix"), cell: (row) => row.key_prefix },
  { key: "status", header: t("identity.features.apiKeys.ui.apiKeyListPage.status"), cell: (row) => row.status },
];

export function ApiKeyListPage({ initialData }: { initialData: { items: ApiKey[] } }) {
  return (
    <AdminListPage
      title={t("identity.features.apiKeys.ui.apiKeyListPage.api.keys")}
      items={initialData.items}
      columns={columns}
      actions={
        <Form spacing="none" method="post">
          <Stack direction="row" align="end" gap={2}>
            <input type="hidden" name="intent" value="create" readOnly />
            <TextInput name="userId" label={t("identity.features.apiKeys.ui.apiKeyListPage.user")} required />
            <TextInput name="name" label={t("identity.features.apiKeys.ui.apiKeyListPage.name")} required />
            <Button type="submit" tone="primary">
              {t("identity.features.apiKeys.ui.apiKeyListPage.create")}
            </Button>
          </Stack>
        </Form>
      }
      emptyMessage={t("identity.features.apiKeys.ui.apiKeyListPage.no.api.keys.yet")}
      getHref={(row) => `/identity/api-keys/${row.api_key_id}`}
    />
  );
}
