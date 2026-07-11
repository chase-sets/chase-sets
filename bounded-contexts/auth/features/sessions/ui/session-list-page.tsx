import { t } from "@chase-sets/localization";
import {
  AdminResourceListPage,
  AppliedFilterChips,
  Form,
  Inline,
  FilterArea,
  Button,
  LinkButton,
  NativeSelect,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useAdminResourceListPageChange } from "@chase-sets/design-system/react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import type { Session } from "./contracts";
import { AUTH_SESSION_STATUSES, type AuthSessionListFilters } from "./list-filters";

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

function sessionStatusFilterLabel(status: string) {
  switch (status) {
    case "active":
      return t("auth.features.sessions.ui.sessionListPage.status.filter.active");
    case "revoked":
      return t("auth.features.sessions.ui.sessionListPage.status.filter.revoked");
    case "expired":
      return t("auth.features.sessions.ui.sessionListPage.status.filter.expired");
    default:
      return t("auth.features.sessions.ui.sessionListPage.status.filter.all");
  }
}

function sessionStatusFilterItems() {
  return [
    { value: "all", label: sessionStatusFilterLabel("all") },
    ...AUTH_SESSION_STATUSES.map((status) => ({ value: status, label: sessionStatusFilterLabel(status) })),
  ];
}

function buildSessionAppliedFilters(filters: AuthSessionListFilters) {
  const applied: { id: string; label: string }[] = [];
  if (filters.search) {
    applied.push({
      id: "search",
      label: t("auth.features.sessions.ui.sessionListPage.search.filter.chip", { search: filters.search }),
    });
  }
  if (filters.status !== "all") {
    applied.push({
      id: "status",
      label: t("auth.features.sessions.ui.sessionListPage.status.filter.chip", {
        status: sessionStatusFilterLabel(filters.status),
      }),
    });
  }

  return applied;
}

export function SessionListPage({
  hrefBase = "/access/sessions",
  initialData,
  filters = { status: "all", search: "" },
}: {
  hrefBase?: string;
  initialData: SessionListResponse;
  filters?: AuthSessionListFilters;
}) {
  const appliedFilters = buildSessionAppliedFilters(filters);
  const onPageChange = useAdminResourceListPageChange(listPagination(initialData));

  return (
    <AdminResourceListPage
      title={t("auth.features.sessions.ui.sessionListPage.sessions")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("auth.features.sessions.ui.sessionListPage.no.sessions.yet")}
      getHref={(row) => `${hrefBase}/${row.session_id}`}
      filters={
        <>
          <Form method="get" spacing="none">
            <FilterArea
              activeFilterCount={appliedFilters.length}
              primaryFilterCount={2}
              panelTitle={t("auth.features.sessions.ui.sessionListPage.filters")}
              overflowTriggerLabel={t("auth.features.sessions.ui.sessionListPage.more.filters")}
              filters={[
                <TextInput
                  key="search"
                  label={t("auth.features.sessions.ui.sessionListPage.search")}
                  name="search"
                  defaultValue={filters.search}
                  placeholder={t("auth.features.sessions.ui.sessionListPage.search.placeholder")}
                />,
                <NativeSelect
                  key="status"
                  label={t("auth.features.sessions.ui.sessionListPage.status")}
                  name="status"
                  defaultValue={filters.status}
                  items={sessionStatusFilterItems()}
                />,
              ]}
              actions={
                <Inline>
                  <Button type="submit" leadingIcon="filter">
                    {t("auth.features.sessions.ui.sessionListPage.apply.filters")}
                  </Button>
                  <LinkButton href={hrefBase} tone="secondary">
                    {t("auth.features.sessions.ui.sessionListPage.clear.filters")}
                  </LinkButton>
                </Inline>
              }
            />
          </Form>
          <AppliedFilterChips
            filters={appliedFilters}
            clearAction={
              appliedFilters.length > 0 ? (
                <LinkButton href={hrefBase} size="sm" tone="secondary">
                  {t("auth.features.sessions.ui.sessionListPage.clear.filters")}
                </LinkButton>
              ) : null
            }
          />
        </>
      }
      pagination={listPagination(initialData)}
      onPageChange={onPageChange}
    />
  );
}
