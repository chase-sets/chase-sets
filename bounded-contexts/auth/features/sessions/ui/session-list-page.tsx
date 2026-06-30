import { t } from "@chase-sets/localization";
import { type DataColumn } from "@chase-sets/design-system";
import type { ListResponse } from "@chase-sets/http/responses";
import { AdminListPage } from "./admin-pages";
import type { Session } from "./contracts";

type SessionListResponse = ListResponse<Session> & Partial<Readonly<{ limit: number; offset: number }>>;

function listPagination(data: SessionListResponse) {
  return typeof data.limit === "number" && typeof data.offset === "number"
    ? { limit: data.limit, offset: data.offset, total: data.total }
    : undefined;
}

function userLabel(session: Session) {
  return session.user_display_name ?? session.user_primary_email ?? session.user_id;
}

function accountLabel(session: Session) {
  return session.account_display_name ?? session.account_name ?? session.account_id;
}

const columns: DataColumn<Session>[] = [
  { key: "user_id", header: t("auth.features.sessions.ui.sessionListPage.user"), cell: userLabel },
  { key: "account_id", header: t("auth.features.sessions.ui.sessionListPage.account"), cell: accountLabel },
  {
    key: "authentication_method",
    header: t("auth.features.sessions.ui.sessionListPage.method"),
    cell: (row) => row.authentication_method,
  },
  { key: "status", header: t("auth.features.sessions.ui.sessionListPage.status"), cell: (row) => row.status },
];

export function SessionListPage({
  hrefBase = "/access/sessions",
  initialData,
}: {
  hrefBase?: string;
  initialData: SessionListResponse;
}) {
  return (
    <AdminListPage
      title={t("auth.features.sessions.ui.sessionListPage.sessions")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("auth.features.sessions.ui.sessionListPage.no.sessions.yet")}
      getHref={(row) => `${hrefBase}/${row.session_id}`}
      pagination={listPagination(initialData)}
    />
  );
}
