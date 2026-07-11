import { t } from "@chase-sets/localization";
import { AdminResourceDetailPage, HiddenInput, Form, Button, Inline, Stack } from "@chase-sets/design-system";
import type { ApiKey, OneTimeApiKeySecret } from "./contracts";
import { ApiKeySecretReveal } from "./api-key-secret-reveal";

export function ApiKeyDetailPage({
  data,
  oneTimeSecret,
}: {
  data: ApiKey;
  oneTimeSecret?: OneTimeApiKeySecret | null;
}) {
  const user = data.user_display_name ?? data.user_primary_email ?? data.user_id;
  return (
    <AdminResourceDetailPage
      breadcrumbs={[
        { label: t("identity.features.apiKeys.ui.apiKeyListPage.api.keys"), href: "/access/api-keys" },
        { label: data.name },
      ]}
      title={data.name}
      status={data.status}
      actions={
        <Stack gap={3}>
          <ApiKeySecretReveal
            secret={
              oneTimeSecret
                ? { ...oneTimeSecret, detailsHref: `/access/api-keys/${oneTimeSecret.apiKeyId}` }
                : oneTimeSecret
            }
          />
          <Inline gap={2}>
            {data.status === "active" ? (
              <>
                <Form spacing="none" method="post">
                  <HiddenInput type="hidden" name="intent" value="rotate" readOnly />
                  <Button type="submit" tone="secondary">
                    {t("identity.features.apiKeys.ui.apiKeyDetailPage.rotate")}
                  </Button>
                </Form>
                <Form spacing="none" method="post">
                  <HiddenInput type="hidden" name="intent" value="revoke" readOnly />
                  <Button type="submit" tone="danger">
                    {t("identity.features.apiKeys.ui.apiKeyDetailPage.revoke")}
                  </Button>
                </Form>
              </>
            ) : null}
          </Inline>
        </Stack>
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
