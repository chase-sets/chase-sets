import { AdminDetailPage } from "../../shell-support/ui/admin-pages";
import type { Session } from "./contracts";

export function SessionDetailPage({ data }: { data: Session }) {
  return (
    <AdminDetailPage
      title={data.session_id}
      status={data.status}
      sections={[
        { label: "User ID", value: data.user_id },
        { label: "Active Account", value: data.account_id },
        { label: "Available Accounts", value: data.available_account_ids.join(", ") },
        { label: "Authentication Method", value: data.authentication_method },
        { label: "Expires At", value: data.expires_at },
      ]}
    />
  );
}
