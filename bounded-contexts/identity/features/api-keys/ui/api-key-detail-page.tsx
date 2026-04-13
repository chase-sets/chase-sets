import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { ApiKey } from "./contracts";

export function ApiKeyDetailPage({ data }: { data: ApiKey }) {
  return (
    <AdminDetailPage
      title={data.name}
      status={data.status}
      sections={[
        { label: "API Key ID", value: data.api_key_id },
        { label: "User ID", value: data.user_id },
        { label: "Key Prefix", value: data.key_prefix },
        { label: "Last Used", value: data.last_used_at ?? "Never" },
        { label: "Updated At", value: data.updated_at },
      ]}
    />
  );
}
