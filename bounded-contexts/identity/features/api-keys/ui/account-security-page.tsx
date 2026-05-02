import { t } from "@chase-sets/localization";
import type { ApiKey } from "./contracts";
import type { User } from "../../users/ui/contracts";
import { CustomerSummaryPage } from "../../../support/ui-support/customer-pages";

export function SecurityPage({
  user,
  apiKeys,
}: {
  user: User;
  apiKeys: readonly ApiKey[];
}) {
  return (
    <CustomerSummaryPage
      title={t("identity.features.apiKeys.ui.accountSecurityPage.security")}
      description={t("identity.features.apiKeys.ui.accountSecurityPage.authentication.methods.passkeys.sessions.and.api")}
      sections={[
        {
          title: t("identity.features.apiKeys.ui.accountSecurityPage.enabled.methods"),
          body: user.auth_methods.join(", ") || t("identity.features.apiKeys.ui.accountSecurityPage.no.interactive.methods.enabled"),
        },
        {
          title: t("identity.features.apiKeys.ui.accountSecurityPage.api.keys"),
          body: apiKeys.length > 0 ? apiKeys.map((key) => key.name).join(", ") : t("identity.features.apiKeys.ui.accountSecurityPage.no.api.keys.yet"),
        },
      ]}
    />
  );
}
