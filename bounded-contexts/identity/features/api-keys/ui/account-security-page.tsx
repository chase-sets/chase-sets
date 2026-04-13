import type { ApiKey } from "./contracts";
import type { User } from "../../users/ui/contracts";
import { CustomerSummaryPage } from "../../../support/ui-support/customer-pages";

export function SecurityPage({
  user,
  apiKeys,
}: {
  user: User;
  apiKeys: readonly ApiKey[];
}) {
  return (
    <CustomerSummaryPage
      title="Security"
      description="Authentication methods, passkeys, sessions, and API keys."
      sections={[
        {
          title: "Enabled Methods",
          body: user.auth_methods.join(", ") || "No interactive methods enabled.",
        },
        {
          title: "API Keys",
          body: apiKeys.length > 0 ? apiKeys.map((key) => key.name).join(", ") : "No API keys yet.",
        },
      ]}
    />
  );
}
