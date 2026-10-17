import { formatDateTime, t } from "@chase-sets/localization";
import {
  AdminResourceDetailPage,
  HiddenInput,
  Form,
  Button,
  Inline,
  ModalDialog,
  Stack,
} from "@chase-sets/design-system";
import type { ApiKey, OneTimeApiKeySecret } from "./contracts";
import { ApiKeySecretReveal } from "./api-key-secret-reveal";
import { apiKeyStatusLabel, identityDateUnavailable } from "../../../support/ui-support/value-labels";

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
      status={apiKeyStatusLabel(data.status)}
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
                <ModalDialog
                  title={t("identity.features.apiKeys.ui.apiKeyDetailPage.revoke.confirm.title", {
                    name: data.name,
                  })}
                  description={t("identity.features.apiKeys.ui.apiKeyDetailPage.revoke.confirm.description", {
                    name: data.name,
                  })}
                  trigger={
                    <Button type="button" tone="danger">
                      {t("identity.features.apiKeys.ui.apiKeyDetailPage.revoke")}
                    </Button>
                  }
                >
                  <Form spacing="none" method="post">
                    <HiddenInput type="hidden" name="intent" value="revoke" readOnly />
                    <Button type="submit" tone="danger">
                      {t("identity.features.apiKeys.ui.apiKeyDetailPage.revoke.confirm.action")}
                    </Button>
                  </Form>
                </ModalDialog>
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
          value: data.last_used_at
            ? formatDateTime(data.last_used_at, { fallback: identityDateUnavailable() })
            : t("identity.features.apiKeys.ui.apiKeyDetailPage.never"),
        },
        {
          label: t("identity.features.apiKeys.ui.apiKeyDetailPage.updated.at"),
          value: formatDateTime(data.updated_at, { fallback: identityDateUnavailable() }),
        },
      ]}
    />
  );
}
