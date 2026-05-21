import { t } from "@chase-sets/localization";
import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "./admin-pages";
import type { Session } from "./contracts";

const columns: DataColumn<Session>[] = [
  { key: "session_id", header: t("auth.features.sessions.ui.sessionListPage.session"), cell: (row) => row.session_id },
  { key: "user_id", header: t("auth.features.sessions.ui.sessionListPage.user"), cell: (row) => row.user_id },
  { key: "account_id", header: t("auth.features.sessions.ui.sessionListPage.account"), cell: (row) => row.account_id },
  {
    key: "authentication_method",
    header: t("auth.features.sessions.ui.sessionListPage.method"),
    cell: (row) => row.authentication_method,
  },
  { key: "status", header: t("auth.features.sessions.ui.sessionListPage.status"), cell: (row) => row.status },
];

export function SessionListPage({ initialData }: { initialData: { items: Session[] } }) {
  return (
    <AdminListPage
      title={t("auth.features.sessions.ui.sessionListPage.sessions")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("auth.features.sessions.ui.sessionListPage.no.sessions.yet")}
      getHref={(row) => `/identity/sessions/${row.session_id}`}
    />
  );
}
