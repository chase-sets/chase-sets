import { t } from "@chase-sets/localization";
import { HiddenInput, Form, Button, NativeSelect, Stack, TextInput } from "@chase-sets/design-system";
import { CustomerSummaryPage } from "../../../support/ui-support/customer-pages";
import type { Membership } from "./contracts";
import type { Invitation } from "../../invitations/ui/contracts";
import { grantableRoleSelectItems } from "./role-select-items";

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
      <Form spacing="none" method="post">
        <Stack direction="row" align="end" gap={2}>
          <HiddenInput type="hidden" name="intent" value="create-invitation" readOnly />
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
            items={grantableRoleSelectItems}
          />
          <Button type="submit" tone="primary">
            {t("identity.features.memberships.ui.accountTeamPage.invite")}
          </Button>
        </Stack>
      </Form>
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
                <Form spacing="none" method="post">
                  <HiddenInput type="hidden" name="intent" value="change-role" readOnly />
                  <HiddenInput type="hidden" name="membershipId" value={membership.membership_id} readOnly />
                  <NativeSelect
                    name="roleKey"
                    label={t("identity.features.memberships.ui.accountTeamPage.role")}
                    defaultValue={membership.role_key}
                    items={grantableRoleSelectItems}
                  />
                  <Button type="submit" tone="secondary">
                    {t("identity.features.memberships.ui.accountTeamPage.change.role")}
                  </Button>
                </Form>
                <Form spacing="none" method="post">
                  <HiddenInput
                    type="hidden"
                    name="intent"
                    value={membership.status === "active" ? "revoke" : "reinstate"}
                    readOnly
                  />
                  <HiddenInput type="hidden" name="membershipId" value={membership.membership_id} readOnly />
                  <Button type="submit" tone={membership.status === "active" ? "danger" : "primary"}>
                    {membership.status === "active"
                      ? t("identity.features.memberships.ui.accountTeamPage.revoke")
                      : t("identity.features.memberships.ui.accountTeamPage.reinstate")}
                  </Button>
                </Form>
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
                <Form spacing="none" method="post">
                  <HiddenInput type="hidden" name="intent" value="cancel-invitation" readOnly />
                  <HiddenInput type="hidden" name="invitationId" value={invitation.invitation_id} readOnly />
                  <Button type="submit" tone="danger">
                    {t("identity.features.memberships.ui.accountTeamPage.cancel")}
                  </Button>
                </Form>
              ) : null,
          })),
        ]}
      />
    </Stack>
  );
}
