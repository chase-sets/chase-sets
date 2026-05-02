import { t } from "@chase-sets/localization";
import type { Consent } from "./contracts";
import { CustomerSummaryPage } from "../../../support/ui-support/customer-pages";

export function ConsentHistoryPage({ consents }: { consents: readonly Consent[] }) {
  return (
    <CustomerSummaryPage
      title={t("identity.features.consents.ui.consentHistoryPage.consent.history")}
      description={t("identity.features.consents.ui.consentHistoryPage.audit.history.for.agreements.policies.and")}
      sections={consents.map((consent) => ({
        title: t("identity.features.consents.ui.consentHistoryPage.policy.title", {
          policyKey: consent.policy_key,
          policyVersion: consent.policy_version,
        }),
        body: consent.recorded_at,
      }))}
    />
  );
}
