import { t } from "@chase-sets/localization";
import { HiddenInput, Form, Button, Combobox, Stack, TextInput, type DataColumn } from "@chase-sets/design-system";
import type { ListResponse } from "@chase-sets/http/responses";
import { AdminListPage } from "../../../support/shell-support/ui/admin-pages";
import type { ApiKey, OneTimeApiKeySecret } from "./contracts";
import type { User } from "../../users/ui/contracts";
import { ApiKeySecretReveal } from "./api-key-secret-reveal";

type PaginatedListResponse<T> = ListResponse<T> & Readonly<{ limit: number; offset: number }>;

function userLabel(apiKey: ApiKey) {
  return apiKey.user_display_name ?? apiKey.user_primary_email ?? apiKey.user_id;
}

const columns: DataColumn<ApiKey>[] = [
  { key: "name", header: t("identity.features.apiKeys.ui.apiKeyListPage.name"), cell: (row) => row.name },
  { key: "user_id", header: t("identity.features.apiKeys.ui.apiKeyListPage.user"), cell: userLabel },
  { key: "key_prefix", header: t("identity.features.apiKeys.ui.apiKeyListPage.prefix"), cell: (row) => row.key_prefix },
  { key: "status", header: t("identity.features.apiKeys.ui.apiKeyListPage.status"), cell: (row) => row.status },
];

function pickerUserLabel(user: User) {
  return user.primary_email ? `${user.display_name} (${user.primary_email})` : user.display_name || user.user_id;
}

export function buildApiKeyUserPickerItems(users: readonly User[]) {
  return users.map((user) => ({
    value: user.user_id,
    label: pickerUserLabel(user),
    description: user.user_id,
  }));
}

export function ApiKeyListPage({
  initialData,
  users,
  oneTimeSecret,
}: {
  initialData: PaginatedListResponse<ApiKey>;
  users: readonly User[];
  oneTimeSecret?: OneTimeApiKeySecret | null;
}) {
  const userItems = buildApiKeyUserPickerItems(users);

  return (
    <AdminListPage
      title={t("identity.features.apiKeys.ui.apiKeyListPage.api.keys")}
      items={initialData.items}
      columns={columns}
      actions={
        <Stack gap={3}>
          <ApiKeySecretReveal
            secret={
              oneTimeSecret
                ? { ...oneTimeSecret, detailsHref: `/access/api-keys/${oneTimeSecret.apiKeyId}` }
                : oneTimeSecret
            }
          />
          <Form spacing="none" method="post">
            <Stack direction="row" align="end" gap={2}>
              <HiddenInput type="hidden" name="intent" value="create" readOnly />
              <Combobox
                name="userId"
                label={t("identity.features.apiKeys.ui.apiKeyListPage.user")}
                items={userItems}
                required
              />
              <TextInput name="name" label={t("identity.features.apiKeys.ui.apiKeyListPage.name")} required />
              <Button type="submit" tone="primary">
                {t("identity.features.apiKeys.ui.apiKeyListPage.create")}
              </Button>
            </Stack>
          </Form>
        </Stack>
      }
      emptyMessage={t("identity.features.apiKeys.ui.apiKeyListPage.no.api.keys.yet")}
      getHref={(row) => `/access/api-keys/${row.api_key_id}`}
      pagination={initialData}
    />
  );
}
