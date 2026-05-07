import { t } from "@chase-sets/localization";
import { type DataColumn } from "@chase-sets/design-system";
import { AdminListPage } from "../../../support/shell-support/ui/admin-pages";
import type { Invitation } from "./contracts";

const columns: DataColumn<Invitation>[] = [
  { key: "email", header: t("identity.features.invitations.ui.invitationListPage.email"), cell: (row) => row.email },
  { key: "account_id", header: t("identity.features.invitations.ui.invitationListPage.account"), cell: (row) => row.account_id },
  { key: "role_key", header: t("identity.features.invitations.ui.invitationListPage.role"), cell: (row) => row.role_key },
  { key: "status", header: t("identity.features.invitations.ui.invitationListPage.status"), cell: (row) => row.status },
];

export function InvitationListPage({
  initialData,
}: {
  initialData: { items: Invitation[] };
}) {
  return (
    <AdminListPage
      title={t("identity.features.invitations.ui.invitationListPage.invitations")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("identity.features.invitations.ui.invitationListPage.no.invitations.yet")}
      getHref={(row) => `/identity/invitations/${row.invitation_id}`}
    />
  );
}
