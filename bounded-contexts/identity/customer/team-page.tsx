import { CustomerSummaryPage } from "../shell-support/ui/customer-pages";
import type { Membership } from "../memberships/ui/contracts";

export function TeamPage({ memberships }: { memberships: readonly Membership[] }) {
  return (
    <CustomerSummaryPage
      title="Team"
      description="Manage the people who can act for this account."
      sections={memberships.map((membership) => ({
        title: membership.user_id,
        body: `${membership.role_key} · ${membership.status}`,
      }))}
    />
  );
}
