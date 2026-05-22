import { t } from "@chase-sets/localization";
import { Button, NativeSelect, Stack, TextInput } from "@chase-sets/design-system";
import { CustomerSummaryPage } from "../../../support/ui-support/customer-pages";
import type { Membership } from "./contracts";
import type { Invitation } from "../../invitations/ui/contracts";

function userLabel(membership: Membership) {
  return membership.user_display_name ?? membership.user_primary_email ?? membership.user_id;
}

export function TeamPage({
  invitations,
  memberships,
}: {
  invitations: readonly Invitation[];
  memberships: readonly Membership[];
}) {
  return (
    <Stack gap={4}>
      <form method="post">
        <Stack direction="row" align="end" gap={2}>
          <input type="hidden" name="intent" value="create-invitation" readOnly />
          <TextInput
            name="email"
            label={t("identity.features.memberships.ui.accountTeamPage.email")}
            type="email"
            required
          />
          <NativeSelect
            name="roleKey"
            label={t("identity.features.memberships.ui.accountTeamPage.role")}
            defaultValue="viewer"
            items={[
              { value: "owner", label: t("identity.features.memberships.ui.role.owner") },
              { value: "manager", label: t("identity.features.memberships.ui.role.manager") },
              { value: "fulfillment", label: t("identity.features.memberships.ui.role.fulfillment") },
              { value: "viewer", label: t("identity.features.memberships.ui.role.viewer") },
            ]}
          />
          <Button type="submit" tone="primary">
            {t("identity.features.memberships.ui.accountTeamPage.invite")}
          </Button>
        </Stack>
      </form>
      <CustomerSummaryPage
        title={t("identity.features.memberships.ui.accountTeamPage.team")}
        description={t("identity.features.memberships.ui.accountTeamPage.manage.the.people.who.can.act")}
        sections={[
          ...memberships.map((membership) => ({
            title: userLabel(membership),
            body: t("identity.features.memberships.ui.accountTeamPage.membership.summary", {
              role: membership.role_key,
              status: membership.status,
            }),
            action: (
              <Stack direction="row" gap={2}>
                <form method="post">
                  <input type="hidden" name="intent" value="change-role" readOnly />
                  <input type="hidden" name="membershipId" value={membership.membership_id} readOnly />
                  <NativeSelect
                    name="roleKey"
                    label={t("identity.features.memberships.ui.accountTeamPage.role")}
                    defaultValue={membership.role_key}
                    items={[
                      { value: "owner", label: t("identity.features.memberships.ui.role.owner") },
                      { value: "manager", label: t("identity.features.memberships.ui.role.manager") },
                      { value: "fulfillment", label: t("identity.features.memberships.ui.role.fulfillment") },
                      { value: "viewer", label: t("identity.features.memberships.ui.role.viewer") },
                    ]}
                  />
                  <Button type="submit" tone="secondary">
                    {t("identity.features.memberships.ui.accountTeamPage.change.role")}
                  </Button>
                </form>
                <form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value={membership.status === "active" ? "revoke" : "reinstate"}
                    readOnly
                  />
                  <input type="hidden" name="membershipId" value={membership.membership_id} readOnly />
                  <Button type="submit" tone={membership.status === "active" ? "danger" : "primary"}>
                    {membership.status === "active"
                      ? t("identity.features.memberships.ui.accountTeamPage.revoke")
                      : t("identity.features.memberships.ui.accountTeamPage.reinstate")}
                  </Button>
                </form>
              </Stack>
            ),
          })),
          ...invitations.map((invitation) => ({
            title: invitation.email,
            body: t("identity.features.memberships.ui.accountTeamPage.invitation.summary", {
              role: invitation.role_key,
              status: invitation.status,
            }),
            action:
              invitation.status === "pending" ? (
                <form method="post">
                  <input type="hidden" name="intent" value="cancel-invitation" readOnly />
                  <input type="hidden" name="invitationId" value={invitation.invitation_id} readOnly />
                  <Button type="submit" tone="danger">
                    {t("identity.features.memberships.ui.accountTeamPage.cancel")}
                  </Button>
                </form>
              ) : null,
          })),
        ]}
      />
    </Stack>
  );
}
