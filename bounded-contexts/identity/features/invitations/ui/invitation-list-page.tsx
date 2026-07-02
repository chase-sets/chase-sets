import { t } from "@chase-sets/localization";
import { HiddenInput, Form, Button, NativeSelect, Stack, TextInput, type DataColumn } from "@chase-sets/design-system";
import type { ListResponse } from "@chase-sets/http/responses";
import { AdminListPage } from "../../../support/shell-support/ui/admin-pages";
import { grantableRoleSelectItems } from "../../memberships/ui/role-select-items";
import type { Account } from "../../accounts/ui/contracts";
import type { Invitation } from "./contracts";

type PaginatedListResponse<T> = ListResponse<T> & Readonly<{ limit: number; offset: number }>;

function accountLabel(invitation: Invitation) {
  return invitation.account_display_name ?? invitation.account_name ?? invitation.account_id;
}

function accountPickerLabel(account: Account) {
  const label = account.display_name || account.name || account.account_id;
  return label === account.account_id ? label : `${label} (${account.account_id})`;
}

const columns: DataColumn<Invitation>[] = [
  { key: "email", header: t("identity.features.invitations.ui.invitationListPage.email"), cell: (row) => row.email },
  {
    key: "account_id",
    header: t("identity.features.invitations.ui.invitationListPage.account"),
    cell: accountLabel,
  },
  {
    key: "role_key",
    header: t("identity.features.invitations.ui.invitationListPage.role"),
    cell: (row) => row.role_key,
  },
  { key: "status", header: t("identity.features.invitations.ui.invitationListPage.status"), cell: (row) => row.status },
];

export function InvitationListPage({
  accounts,
  initialData,
}: {
  accounts: readonly Account[];
  initialData: PaginatedListResponse<Invitation>;
}) {
  const accountSelectItems = accounts.map((account) => ({
    value: account.account_id,
    label: accountPickerLabel(account),
  }));
  const hasAccounts = accountSelectItems.length > 0;

  return (
    <AdminListPage
      title={t("identity.features.invitations.ui.invitationListPage.invitations")}
      items={initialData.items}
      columns={columns}
      actions={
        <Form spacing="none" method="post">
          <Stack direction="row" align="end" gap={2}>
            <HiddenInput type="hidden" name="intent" value="create" readOnly />
            <NativeSelect
              name="accountId"
              label={t("identity.features.invitations.ui.invitationListPage.account")}
              placeholder={t("identity.features.invitations.ui.invitationListPage.select.account")}
              items={accountSelectItems}
              required
              disabled={!hasAccounts}
            />
            <TextInput
              name="email"
              label={t("identity.features.invitations.ui.invitationListPage.email")}
              type="email"
              required
            />
            <NativeSelect
              name="roleKey"
              label={t("identity.features.invitations.ui.invitationListPage.role")}
              defaultValue="viewer"
              items={grantableRoleSelectItems}
            />
            <Button type="submit" tone="primary" disabled={!hasAccounts}>
              {t("identity.features.invitations.ui.invitationListPage.create")}
            </Button>
          </Stack>
        </Form>
      }
      emptyMessage={t("identity.features.invitations.ui.invitationListPage.no.invitations.yet")}
      getHref={(row) => `/access/invitations/${row.invitation_id}`}
      pagination={initialData}
    />
  );
}
