import { t } from "@chase-sets/localization";
import { CustomerSummaryPage } from "../../../support/ui-support/customer-pages";
import type { Membership } from "./contracts";

export function TeamPage({ memberships }: { memberships: readonly Membership[] }) {
  return (
    <CustomerSummaryPage
      title={t("identity.features.memberships.ui.accountTeamPage.team")}
      description={t("identity.features.memberships.ui.accountTeamPage.manage.the.people.who.can.act")}
      sections={memberships.map((membership) => ({
        title: membership.user_id,
        body: t("identity.features.memberships.ui.accountTeamPage.membership.summary", {
          role: membership.role_key,
          status: membership.status,
        }),
      }))}
    />
  );
}
