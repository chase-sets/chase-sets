import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { User } from "./contracts";

export function UserDetailPage({ data }: { data: User }) {
  return (
    <AdminDetailPage
      title={data.display_name}
      status={data.status}
      sections={[
        { label: "User ID", value: data.user_id },
        { label: "Email", value: data.primary_email },
        { label: "Given Name", value: data.given_name || "None" },
        { label: "Family Name", value: data.family_name || "None" },
        { label: "Auth Methods", value: data.auth_methods.join(", ") || "None" },
        { label: "Updated At", value: data.updated_at },
      ]}
    />
  );
}
