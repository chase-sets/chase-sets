import { t } from "@chase-sets/localization";
import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { Invitation } from "./contracts";

export function InvitationDetailPage({ data }: { data: Invitation }) {
  return (
    <AdminDetailPage
      title={data.email}
      status={data.status}
      sections={[
        { label: t("identity.features.invitations.ui.invitationDetailPage.invitation.id"), value: data.invitation_id },
        { label: t("identity.features.invitations.ui.invitationDetailPage.account.id"), value: data.account_id },
        { label: t("identity.features.invitations.ui.invitationDetailPage.role"), value: data.role_key },
        { label: t("identity.features.invitations.ui.invitationDetailPage.expires.at"), value: data.expires_at },
        {
          label: t("identity.features.invitations.ui.invitationDetailPage.accepted.by"),
          value: data.accepted_by_user_id ?? t("identity.features.invitations.ui.invitationDetailPage.pending"),
        },
      ]}
    />
  );
}
