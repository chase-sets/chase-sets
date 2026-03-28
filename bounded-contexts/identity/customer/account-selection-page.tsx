import { CustomerSummaryPage } from "../shell-support/ui/customer-pages";

export function AccountSelectionPage({
  memberships,
}: {
  memberships: readonly { accountId: string; roleKey: string }[];
}) {
  return (
    <CustomerSummaryPage
      title="Choose Account"
      description="This user can act for more than one account."
      sections={memberships.map((membership) => ({
        title: membership.accountId,
        body: `Role: ${membership.roleKey}`,
      }))}
    />
  );
}
