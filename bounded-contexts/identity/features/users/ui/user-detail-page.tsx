import { t } from "@chase-sets/localization";
import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { User } from "./contracts";

export function UserDetailPage({ data }: { data: User }) {
  return (
    <AdminDetailPage
      title={data.display_name}
      status={data.status}
      sections={[
        { label: t("identity.features.users.ui.userDetailPage.user.id"), value: data.user_id },
        { label: t("identity.features.users.ui.userDetailPage.email"), value: data.primary_email },
        { label: t("identity.features.users.ui.userDetailPage.given.name"), value: data.given_name || t("identity.features.users.ui.userDetailPage.none") },
        { label: t("identity.features.users.ui.userDetailPage.family.name"), value: data.family_name || t("identity.features.users.ui.userDetailPage.none.2") },
        { label: t("identity.features.users.ui.userDetailPage.auth.methods"), value: data.auth_methods.join(", ") || t("identity.features.users.ui.userDetailPage.none.3") },
        { label: t("identity.features.users.ui.userDetailPage.updated.at"), value: data.updated_at },
      ]}
    />
  );
}
