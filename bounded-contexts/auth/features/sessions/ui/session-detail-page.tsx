import { t } from "@chase-sets/localization";
import { AdminDetailPage } from "./admin-pages";
import type { Session } from "./contracts";

export function SessionDetailPage({ data }: { data: Session }) {
  return (
    <AdminDetailPage
      title={data.session_id}
      status={data.status}
      sections={[
        { label: t("auth.features.sessions.ui.sessionDetailPage.user.id"), value: data.user_id },
        { label: t("auth.features.sessions.ui.sessionDetailPage.active.account"), value: data.account_id },
        {
          label: t("auth.features.sessions.ui.sessionDetailPage.available.accounts"),
          value: data.available_account_ids.join(", "),
        },
        {
          label: t("auth.features.sessions.ui.sessionDetailPage.authentication.method"),
          value: data.authentication_method,
        },
        { label: t("auth.features.sessions.ui.sessionDetailPage.expires.at"), value: data.expires_at },
      ]}
    />
  );
}
