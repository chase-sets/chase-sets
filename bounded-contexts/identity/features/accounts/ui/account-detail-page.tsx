import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { Account } from "./contracts";

export function AccountDetailPage({ data }: { data: Account }) {
  return (
    <AdminDetailPage
      title={data.display_name}
      status={data.status}
      sections={[
        { label: "Account ID", value: data.account_id },
        { label: "Legal Name", value: data.name },
        { label: "Account Type", value: data.account_type },
        { label: "Updated At", value: data.updated_at },
      ]}
    />
  );
}
