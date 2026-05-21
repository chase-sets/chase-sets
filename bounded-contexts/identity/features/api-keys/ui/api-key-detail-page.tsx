import { t } from "@chase-sets/localization";
import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { ApiKey } from "./contracts";

export function ApiKeyDetailPage({ data }: { data: ApiKey }) {
  return (
    <AdminDetailPage
      title={data.name}
      status={data.status}
      sections={[
        { label: t("identity.features.apiKeys.ui.apiKeyDetailPage.api.key.id"), value: data.api_key_id },
        { label: t("identity.features.apiKeys.ui.apiKeyDetailPage.user.id"), value: data.user_id },
        { label: t("identity.features.apiKeys.ui.apiKeyDetailPage.key.prefix"), value: data.key_prefix },
        {
          label: t("identity.features.apiKeys.ui.apiKeyDetailPage.last.used"),
          value: data.last_used_at ?? t("identity.features.apiKeys.ui.apiKeyDetailPage.never"),
        },
        { label: t("identity.features.apiKeys.ui.apiKeyDetailPage.updated.at"), value: data.updated_at },
      ]}
    />
  );
}
