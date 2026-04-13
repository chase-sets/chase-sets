import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { Membership } from "./contracts";

export function MembershipDetailPage({ data }: { data: Membership }) {
  return (
    <AdminDetailPage
      title={data.membership_id}
      status={data.status}
      sections={[
        { label: "Membership ID", value: data.membership_id },
        { label: "User ID", value: data.user_id },
        { label: "Account ID", value: data.account_id },
        { label: "Role", value: data.role_key },
        { label: "Updated At", value: data.updated_at },
      ]}
    />
  );
}
