import { CustomerSummaryPage } from "../shell-support/ui/customer-pages";
import type { Account } from "../accounts/ui/contracts";

export function AccountProfilePage({ account }: { account: Account }) {
  return (
    <CustomerSummaryPage
      title={account.display_name}
      description="Profile and commercial ownership details for your active account."
      sections={[
        { title: "Account Type", body: account.account_type },
        { title: "Legal Name", body: account.name },
        { title: "Status", body: account.status },
      ]}
    />
  );
}
