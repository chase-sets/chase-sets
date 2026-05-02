import { t } from "@chase-sets/localization";
import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { Account } from "./contracts";

export function AccountDetailPage({ data }: { data: Account }) {
  return (
    <AdminDetailPage
      title={data.display_name}
      status={data.status}
      sections={[
        { label: t("identity.features.accounts.ui.accountDetailPage.account.id"), value: data.account_id },
        { label: t("identity.features.accounts.ui.accountDetailPage.legal.name"), value: data.name },
        { label: t("identity.features.accounts.ui.accountDetailPage.account.type"), value: data.account_type },
        { label: t("identity.features.accounts.ui.accountDetailPage.updated.at"), value: data.updated_at },
      ]}
    />
  );
}
