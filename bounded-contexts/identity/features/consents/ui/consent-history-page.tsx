import type { Consent } from "./contracts";
import { CustomerSummaryPage } from "../../../support/ui-support/customer-pages";

export function ConsentHistoryPage({ consents }: { consents: readonly Consent[] }) {
  return (
    <CustomerSummaryPage
      title="Consent History"
      description="Audit history for agreements, policies, and acknowledgements."
      sections={consents.map((consent) => ({
        title: `${consent.policy_key} ${consent.policy_version}`,
        body: consent.recorded_at,
      }))}
    />
  );
}
