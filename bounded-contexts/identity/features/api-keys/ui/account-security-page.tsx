import { t } from "@chase-sets/localization";
import type { ApiKey } from "./contracts";
import type { User } from "../../users/ui/contracts";
import {
  MarketplaceDashboardPanel,
  PlatformCredibilityCue,
  SecurePaymentCue,
  SpecificationList,
  Stack,
  UiPage,
  UiPageHeader,
  UiPageSection,
} from "@chase-sets/design-system";

export function SecurityPage({ user, apiKeys }: { user: User; apiKeys: readonly ApiKey[] }) {
  const enabledMethods = user.auth_methods.length
    ? user.auth_methods.join(", ")
    : t("identity.features.apiKeys.ui.accountSecurityPage.no.interactive.methods.enabled");
  const activeApiKeys = apiKeys.filter((key) => key.status === "active").length;
  const lastUpdated = user.updated_at
    ? new Date(user.updated_at).toLocaleDateString()
    : t("identity.features.apiKeys.ui.accountSecurityPage.not.available");

  return (
    <UiPage>
      <UiPageHeader
        eyebrow={t("identity.features.apiKeys.ui.accountSecurityPage.account")}
        title={t("identity.features.apiKeys.ui.accountSecurityPage.security")}
        description={t(
          "identity.features.apiKeys.ui.accountSecurityPage.authentication.methods.passkeys.sessions.and.api",
        )}
      />
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
      <UiPageSection
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
          <PlatformCredibilityCue
            title={t("identity.features.apiKeys.ui.accountSecurityPage.checkout.safety")}
            description={t("identity.features.apiKeys.ui.accountSecurityPage.checkout.safety.description")}
          />
        </Stack>
      </UiPageSection>
    </UiPage>
  );
}
