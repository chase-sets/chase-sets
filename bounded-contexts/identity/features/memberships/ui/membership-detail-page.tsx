import { t } from "@chase-sets/localization";
import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { Membership } from "./contracts";

export function MembershipDetailPage({ data }: { data: Membership }) {
  return (
    <AdminDetailPage
      title={data.membership_id}
      status={data.status}
      sections={[
        { label: t("identity.features.memberships.ui.membershipDetailPage.membership.id"), value: data.membership_id },
        { label: t("identity.features.memberships.ui.membershipDetailPage.user.id"), value: data.user_id },
        { label: t("identity.features.memberships.ui.membershipDetailPage.account.id"), value: data.account_id },
        { label: t("identity.features.memberships.ui.membershipDetailPage.role"), value: data.role_key },
        { label: t("identity.features.memberships.ui.membershipDetailPage.updated.at"), value: data.updated_at },
      ]}
    />
  );
}
