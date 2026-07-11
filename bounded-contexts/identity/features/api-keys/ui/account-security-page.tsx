import { formatDate, t } from "@chase-sets/localization";
import type { ApiKey, OneTimeApiKeySecret } from "./contracts";
import type { User } from "../../users/ui/contracts";
import {
  HiddenInput,
  Form,
  Button,
  MarketplaceDashboardPanel,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  PlatformCredibilityCue,
  SecurePaymentCue,
  SpecificationList,
  Stack,
  TextInput,
} from "@chase-sets/design-system";
import { ApiKeySecretReveal } from "./api-key-secret-reveal";

export function SecurityPage({
  user,
  apiKeys,
  oneTimeSecret,
}: {
  user: User;
  apiKeys: readonly ApiKey[];
  oneTimeSecret?: OneTimeApiKeySecret | null;
}) {
  const enabledMethods = user.auth_methods.length
    ? user.auth_methods.join(", ")
    : t("identity.features.apiKeys.ui.accountSecurityPage.no.interactive.methods.enabled");
  const activeApiKeys = apiKeys.filter((key) => key.status === "active").length;
  const lastUpdated = user.updated_at
    ? formatDate(user.updated_at)
    : t("identity.features.apiKeys.ui.accountSecurityPage.not.available");

  return (
    <Page>
      <PageHeader
        eyebrow={t("identity.features.apiKeys.ui.accountSecurityPage.account")}
        title={t("identity.features.apiKeys.ui.accountSecurityPage.security")}
        description={t(
          "identity.features.apiKeys.ui.accountSecurityPage.authentication.methods.passkeys.sessions.and.api",
        )}
        actions={
          <Stack direction="row" gap={2}>
            <Form spacing="none" method="post">
              <Stack direction="row" align="end" gap={2}>
                <HiddenInput type="hidden" name="intent" value="update-user" readOnly />
                <TextInput
                  name="displayName"
                  label={t("identity.features.users.ui.userDetailPage.display.name")}
                  defaultValue={user.display_name}
                  required
                />
                <TextInput
                  name="givenName"
                  label={t("identity.features.users.ui.userDetailPage.given.name")}
                  defaultValue={user.given_name}
                />
                <TextInput
                  name="familyName"
                  label={t("identity.features.users.ui.userDetailPage.family.name")}
                  defaultValue={user.family_name}
                />
                <Button type="submit" tone="secondary">
                  {t("identity.features.apiKeys.ui.accountSecurityPage.update.profile")}
                </Button>
              </Stack>
            </Form>
            <Form spacing="none" method="post">
              <Stack direction="row" align="end" gap={2}>
                <HiddenInput type="hidden" name="intent" value="create-api-key" readOnly />
                <TextInput
                  name="name"
                  label={t("identity.features.apiKeys.ui.accountSecurityPage.api.key.name")}
                  required
                />
                <NativeSelect
                  name="purpose"
                  label={t("identity.features.apiKeys.ui.accountSecurityPage.purpose")}
                  defaultValue="integration"
                  items={[
                    {
                      value: "integration",
                      label: t("identity.features.apiKeys.ui.accountSecurityPage.integration"),
                    },
                  ]}
                />
                <Button type="submit" tone="primary">
                  {t("identity.features.apiKeys.ui.accountSecurityPage.create.api.key")}
                </Button>
              </Stack>
            </Form>
          </Stack>
        }
      />
      <ApiKeySecretReveal secret={oneTimeSecret} />
      <MarketplaceDashboardPanel
        title={t("identity.features.apiKeys.ui.accountSecurityPage.account.protection")}
        description={t("identity.features.apiKeys.ui.accountSecurityPage.account.protection.description")}
        metrics={[
          {
            label: t("identity.features.apiKeys.ui.accountSecurityPage.enabled.methods"),
            value: user.auth_methods.length,
            detail: enabledMethods,
          },
          {
            label: t("identity.features.apiKeys.ui.accountSecurityPage.api.keys"),
            value: activeApiKeys,
            detail: apiKeys.length
              ? t("identity.features.apiKeys.ui.accountSecurityPage.active.keys.detail", {
                  count: apiKeys.length,
                })
              : t("identity.features.apiKeys.ui.accountSecurityPage.no.api.keys.yet"),
          },
          {
            label: t("identity.features.apiKeys.ui.accountSecurityPage.updated"),
            value: lastUpdated,
            detail: t("identity.features.apiKeys.ui.accountSecurityPage.review.security.before.checkout"),
          },
        ]}
      />
      <PageSection
        title={t("identity.features.apiKeys.ui.accountSecurityPage.security.signals")}
        description={t("identity.features.apiKeys.ui.accountSecurityPage.security.signals.description")}
      >
        <Stack>
          <SecurePaymentCue label={t("identity.features.apiKeys.ui.accountSecurityPage.sign.in.methods.verified")} />
          <SpecificationList
            specs={[
              {
                label: t("identity.features.apiKeys.ui.accountSecurityPage.enabled.methods"),
                value: enabledMethods,
              },
              {
                label: t("identity.features.apiKeys.ui.accountSecurityPage.api.keys"),
                value:
                  apiKeys.length > 0
                    ? apiKeys.map((key) => `${key.name} (${key.status})`).join(", ")
                    : t("identity.features.apiKeys.ui.accountSecurityPage.no.api.keys.yet"),
              },
            ]}
          />
          <Stack gap={2}>
            {apiKeys.map((apiKey) => (
              <Stack key={apiKey.api_key_id} direction="row" justify="between" align="center" gap={2}>
                <SpecificationList
                  specs={[
                    { label: t("identity.features.apiKeys.ui.accountSecurityPage.api.key"), value: apiKey.name },
                    { label: t("identity.features.apiKeys.ui.accountSecurityPage.status"), value: apiKey.status },
                  ]}
                />
                {apiKey.status === "active" ? (
                  <Stack direction="row" gap={2}>
                    <Form spacing="none" method="post">
                      <HiddenInput type="hidden" name="intent" value="rotate-api-key" readOnly />
                      <HiddenInput type="hidden" name="apiKeyId" value={apiKey.api_key_id} readOnly />
                      <Button type="submit" tone="secondary">
                        {t("identity.features.apiKeys.ui.accountSecurityPage.rotate")}
                      </Button>
                    </Form>
                    <Form spacing="none" method="post">
                      <HiddenInput type="hidden" name="intent" value="revoke-api-key" readOnly />
                      <HiddenInput type="hidden" name="apiKeyId" value={apiKey.api_key_id} readOnly />
                      <Button type="submit" tone="danger">
                        {t("identity.features.apiKeys.ui.accountSecurityPage.revoke")}
                      </Button>
                    </Form>
                  </Stack>
                ) : null}
              </Stack>
            ))}
          </Stack>
          <PlatformCredibilityCue
            title={t("identity.features.apiKeys.ui.accountSecurityPage.checkout.safety")}
            description={t("identity.features.apiKeys.ui.accountSecurityPage.checkout.safety.description")}
          />
        </Stack>
      </PageSection>
    </Page>
  );
}
