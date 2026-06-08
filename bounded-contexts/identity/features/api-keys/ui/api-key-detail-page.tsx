import { t } from "@chase-sets/localization";
import { Form, Button, Inline } from "@chase-sets/design-system";
import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { ApiKey } from "./contracts";

export function ApiKeyDetailPage({ data }: { data: ApiKey }) {
  const user = data.user_display_name ?? data.user_primary_email ?? data.user_id;
  return (
    <AdminDetailPage
      breadcrumbs={[
        { label: t("identity.features.apiKeys.ui.apiKeyListPage.api.keys"), href: "/access/api-keys" },
        { label: data.name },
      ]}
      title={data.name}
      status={data.status}
      actions={
        <Inline gap={2}>
          {data.status === "active" ? (
            <>
              <Form spacing="none" method="post">
                <input type="hidden" name="intent" value="rotate" readOnly />
                <Button type="submit" tone="secondary">
                  {t("identity.features.apiKeys.ui.apiKeyDetailPage.rotate")}
                </Button>
              </Form>
              <Form spacing="none" method="post">
                <input type="hidden" name="intent" value="revoke" readOnly />
                <Button type="submit" tone="danger">
                  {t("identity.features.apiKeys.ui.apiKeyDetailPage.revoke")}
                </Button>
              </Form>
            </>
          ) : null}
        </Inline>
      }
      sections={[
        { label: t("identity.features.apiKeys.ui.apiKeyDetailPage.api.key.id"), value: data.api_key_id },
        { label: t("identity.features.apiKeys.ui.apiKeyDetailPage.user"), value: user },
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
