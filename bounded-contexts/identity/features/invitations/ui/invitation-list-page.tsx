import { t } from "@chase-sets/localization";
import { Form, Button, NativeSelect, Stack, TextInput, type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../../support/shell-support/ui/admin-pages";
import type { Invitation } from "./contracts";

function accountLabel(invitation: Invitation) {
  return invitation.account_display_name ?? invitation.account_name ?? invitation.account_id;
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

export function InvitationListPage({ initialData }: { initialData: { items: Invitation[] } }) {
  return (
    <AdminListPage
      title={t("identity.features.invitations.ui.invitationListPage.invitations")}
      items={initialData.items}
      columns={columns}
      actions={
        <Form spacing="none" method="post">
          <Stack direction="row" align="end" gap={2}>
            <input type="hidden" name="intent" value="create" readOnly />
            <TextInput
              name="accountId"
              label={t("identity.features.invitations.ui.invitationListPage.account")}
              required
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
              items={[
                { value: "owner", label: t("identity.features.memberships.ui.role.owner") },
                { value: "manager", label: t("identity.features.memberships.ui.role.manager") },
                { value: "fulfillment", label: t("identity.features.memberships.ui.role.fulfillment") },
                { value: "viewer", label: t("identity.features.memberships.ui.role.viewer") },
              ]}
            />
            <Button type="submit" tone="primary">
              {t("identity.features.invitations.ui.invitationListPage.create")}
            </Button>
          </Stack>
        </Form>
      }
      emptyMessage={t("identity.features.invitations.ui.invitationListPage.no.invitations.yet")}
      getHref={(row) => `/access/invitations/${row.invitation_id}`}
    />
  );
}
