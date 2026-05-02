import { t } from "@chase-sets/localization";
import { CustomerSummaryPage } from "../../../support/ui-support/customer-pages";
import type { Account } from "./contracts";

export function AccountProfilePage({ account }: { account: Account }) {
  return (
    <CustomerSummaryPage
      title={account.display_name}
      description={t("identity.features.accounts.ui.accountProfilePage.profile.and.commercial.ownership.details.for")}
      sections={[
        { title: t("identity.features.accounts.ui.accountProfilePage.account.type"), body: account.account_type },
        { title: t("identity.features.accounts.ui.accountProfilePage.legal.name"), body: account.name },
        { title: t("identity.features.accounts.ui.accountProfilePage.status"), body: account.status },
      ]}
    />
  );
}
