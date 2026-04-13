import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { Invitation } from "./contracts";

export function InvitationDetailPage({ data }: { data: Invitation }) {
  return (
    <AdminDetailPage
      title={data.email}
      status={data.status}
      sections={[
        { label: "Invitation ID", value: data.invitation_id },
        { label: "Account ID", value: data.account_id },
        { label: "Role", value: data.role_key },
        { label: "Expires At", value: data.expires_at },
        { label: "Accepted By", value: data.accepted_by_user_id ?? "Pending" },
      ]}
    />
  );
}
