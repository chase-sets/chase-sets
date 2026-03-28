import type { Consent } from "../consents/ui/contracts";
import { CustomerSummaryPage } from "../shell-support/ui/customer-pages";

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
