import { t } from "@chase-sets/localization";
import {
  AdminResourceListPage,
  AppliedFilterChips,
  HiddenInput,
  Form,
  Inline,
  FilterArea,
  Button,
  Combobox,
  LinkButton,
  NativeSelect,
  Stack,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useAdminResourceListPageChange } from "@chase-sets/design-system/react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { IDENTITY_API_KEY_STATUSES, type IdentityListFilters } from "../../../support/route-support/list-filters";
import type { ApiKey, OneTimeApiKeySecret } from "./contracts";
import type { User } from "../../users/ui/contracts";
import { ApiKeySecretReveal } from "./api-key-secret-reveal";
import { apiKeyStatusLabel } from "../../../support/ui-support/value-labels";

type PaginatedListResponse<T> = ListResponse<T> & Readonly<{ limit: number; offset: number }>;

function userLabel(apiKey: ApiKey) {
  return apiKey.user_display_name ?? apiKey.user_primary_email ?? apiKey.user_id;
}

const columns: DataColumn<ApiKey>[] = [
  { key: "name", header: t("identity.features.apiKeys.ui.apiKeyListPage.name"), cell: (row) => row.name },
  { key: "user_id", header: t("identity.features.apiKeys.ui.apiKeyListPage.user"), cell: userLabel },
  { key: "key_prefix", header: t("identity.features.apiKeys.ui.apiKeyListPage.prefix"), cell: (row) => row.key_prefix },
  {
    key: "status",
    header: t("identity.features.apiKeys.ui.apiKeyListPage.status"),
    cell: (row) => apiKeyStatusLabel(row.status),
  },
];

function pickerUserLabel(user: User) {
  return user.primary_email ? `${user.display_name} (${user.primary_email})` : user.display_name || user.user_id;
}

export function buildApiKeyUserPickerItems(users: readonly User[]) {
  return users.map((user) => ({
    value: user.user_id,
    label: pickerUserLabel(user),
    description: user.user_id,
  }));
}

function apiKeyStatusFilterLabel(status: string) {
  return status === "all"
    ? t("identity.features.apiKeys.ui.apiKeyListPage.status.filter.all")
    : apiKeyStatusLabel(status);
}

function apiKeyStatusFilterItems() {
  return [
    { value: "all", label: apiKeyStatusFilterLabel("all") },
    ...IDENTITY_API_KEY_STATUSES.map((status) => ({ value: status, label: apiKeyStatusFilterLabel(status) })),
  ];
}

function buildApiKeyAppliedFilters(filters: IdentityListFilters) {
  const applied: { id: string; label: string }[] = [];
  if (filters.search) {
    applied.push({
      id: "search",
      label: t("identity.features.apiKeys.ui.apiKeyListPage.search.filter.chip", { search: filters.search }),
    });
  }
  if (filters.status !== "all") {
    applied.push({
      id: "status",
      label: t("identity.features.apiKeys.ui.apiKeyListPage.status.filter.chip", {
        status: apiKeyStatusFilterLabel(filters.status),
      }),
    });
  }

  return applied;
}

export function ApiKeyListPage({
  initialData,
  users,
  oneTimeSecret,
  filters = { status: "all", search: "" },
}: {
  initialData: PaginatedListResponse<ApiKey>;
  users: readonly User[];
  oneTimeSecret?: OneTimeApiKeySecret | null;
  filters?: IdentityListFilters;
}) {
  const userItems = buildApiKeyUserPickerItems(users);
  const appliedFilters = buildApiKeyAppliedFilters(filters);
  const onPageChange = useAdminResourceListPageChange(initialData);

  return (
    <AdminResourceListPage
      title={t("identity.features.apiKeys.ui.apiKeyListPage.api.keys")}
      items={initialData.items}
      columns={columns}
      actions={
        <Stack gap={3}>
          <ApiKeySecretReveal
            secret={
              oneTimeSecret
                ? { ...oneTimeSecret, detailsHref: `/access/api-keys/${oneTimeSecret.apiKeyId}` }
                : oneTimeSecret
            }
          />
          <Form spacing="none" method="post">
            <Stack direction="row" align="end" gap={2}>
              <HiddenInput type="hidden" name="intent" value="create" readOnly />
              <Combobox
                name="userId"
                label={t("identity.features.apiKeys.ui.apiKeyListPage.user")}
                items={userItems}
                required
              />
              <TextInput name="name" label={t("identity.features.apiKeys.ui.apiKeyListPage.name")} required />
              <Button type="submit" tone="primary">
                {t("identity.features.apiKeys.ui.apiKeyListPage.create")}
              </Button>
            </Stack>
          </Form>
        </Stack>
      }
      filters={
        <>
          <Form method="get" spacing="none">
            <FilterArea
              activeFilterCount={appliedFilters.length}
              primaryFilterCount={2}
              panelTitle={t("identity.features.apiKeys.ui.apiKeyListPage.filters")}
              overflowTriggerLabel={t("identity.features.apiKeys.ui.apiKeyListPage.more.filters")}
              filters={[
                <TextInput
                  key="search"
                  label={t("identity.features.apiKeys.ui.apiKeyListPage.search")}
                  name="search"
                  defaultValue={filters.search}
                  placeholder={t("identity.features.apiKeys.ui.apiKeyListPage.search.placeholder")}
                />,
                <NativeSelect
                  key="status"
                  label={t("identity.features.apiKeys.ui.apiKeyListPage.status")}
                  name="status"
                  defaultValue={filters.status}
                  items={apiKeyStatusFilterItems()}
                />,
              ]}
              actions={
                <Inline>
                  <Button type="submit" leadingIcon="filter">
                    {t("identity.features.apiKeys.ui.apiKeyListPage.apply.filters")}
                  </Button>
                  <LinkButton href="/access/api-keys" tone="secondary">
                    {t("identity.features.apiKeys.ui.apiKeyListPage.clear.filters")}
                  </LinkButton>
                </Inline>
              }
            />
          </Form>
          <AppliedFilterChips
            filters={appliedFilters}
            clearAction={
              appliedFilters.length > 0 ? (
                <LinkButton href="/access/api-keys" size="sm" tone="secondary">
                  {t("identity.features.apiKeys.ui.apiKeyListPage.clear.filters")}
                </LinkButton>
              ) : null
            }
          />
        </>
      }
      emptyMessage={t("identity.features.apiKeys.ui.apiKeyListPage.no.api.keys.yet")}
      getHref={(row) => `/access/api-keys/${row.api_key_id}`}
      pagination={initialData}
      onPageChange={onPageChange}
    />
  );
}
