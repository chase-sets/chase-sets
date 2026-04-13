import { CustomerSummaryPage } from "../../../support/ui-support/customer-pages";
import type { Account } from "./contracts";

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
