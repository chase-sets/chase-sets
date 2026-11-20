import { t } from "@chase-sets/localization";
import { AccountMutationForm as Form } from "../../account-management/ui/controller";
import { HiddenInput, Banner, Button, ModalDialog, NativeSelect, Stack, TextInput } from "@chase-sets/design-system";
import { CustomerSummaryPage } from "../../../support/ui-support/customer-pages";
import type { Membership } from "./contracts";
import type { Invitation } from "../../invitations/ui/contracts";
import { grantableRoleSelectItems } from "./role-select-items";
import {
  invitationStatusLabel,
  membershipRoleLabel,
  membershipStatusLabel,
} from "../../../support/ui-support/value-labels";

function userLabel(membership: Membership) {
  return membership.user_display_name ?? membership.user_primary_email ?? membership.user_id;
}

function membershipAccountLabel(membership: Membership) {
  return membership.account_display_name ?? membership.account_name ?? membership.account_id;
}

function invitationAccountLabel(invitation: Invitation) {
  return invitation.account_display_name ?? invitation.account_name ?? invitation.account_id;
}

function unsentDescription(invitations: readonly Invitation[], unsentInvitationId: string) {
  const unsent = invitations.find((invitation) => invitation.invitation_id === unsentInvitationId);
  if (!unsent) return t("identity.features.memberships.ui.accountTeamPage.invitation.unsent.unlisted");
  // A notice about an invitation no longer pending has nothing left to send.
  if (unsent.status !== "pending") return null;
  return t("identity.features.memberships.ui.accountTeamPage.invitation.unsent.description", { email: unsent.email });
}

export function TeamPage({
  invitations,
  memberships,
  errorMessage,
  unsentInvitationId,
}: {
  invitations: readonly Invitation[];
  memberships: readonly Membership[];
  errorMessage?: string;
  /** An invitation the last write saved but could not email. */
  unsentInvitationId?: string | null;
}) {
  const unsent = unsentInvitationId ? unsentDescription(invitations, unsentInvitationId) : null;
  return (
    <CustomerSummaryPage
      title={t("identity.features.memberships.ui.accountTeamPage.team")}
      description={t("identity.features.memberships.ui.accountTeamPage.manage.the.people.who.can.act")}
      controls={
        <>
          {errorMessage ? <Banner tone="danger" title={errorMessage} /> : null}
          {unsent ? (
            <Banner
              tone="warning"
              title={t("identity.features.memberships.ui.accountTeamPage.invitation.unsent")}
              description={unsent}
            />
          ) : null}
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
        </>
      }
      sections={[
        ...memberships.map((membership) => ({
          title: userLabel(membership),
          body: t("identity.features.memberships.ui.accountTeamPage.membership.summary", {
            role: membershipRoleLabel(membership.role_key),
            status: membershipStatusLabel(membership.status),
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
              {membership.status === "active" ? (
                <ModalDialog
                  title={t("identity.features.memberships.ui.accountTeamPage.revoke.confirm.title", {
                    user: userLabel(membership),
                  })}
                  description={t("identity.features.memberships.ui.accountTeamPage.revoke.confirm.description", {
                    user: userLabel(membership),
                    account: membershipAccountLabel(membership),
                  })}
                  trigger={
                    <Button type="button" tone="danger">
                      {t("identity.features.memberships.ui.accountTeamPage.revoke")}
                    </Button>
                  }
                >
                  <Form spacing="none" method="post">
                    <HiddenInput type="hidden" name="intent" value="revoke" readOnly />
                    <HiddenInput type="hidden" name="membershipId" value={membership.membership_id} readOnly />
                    <Button type="submit" tone="danger">
                      {t("identity.features.memberships.ui.accountTeamPage.revoke.confirm.action")}
                    </Button>
                  </Form>
                </ModalDialog>
              ) : (
                <Form spacing="none" method="post">
                  <HiddenInput type="hidden" name="intent" value="reinstate" readOnly />
                  <HiddenInput type="hidden" name="membershipId" value={membership.membership_id} readOnly />
                  <Button type="submit" tone="primary">
                    {t("identity.features.memberships.ui.accountTeamPage.reinstate")}
                  </Button>
                </Form>
              )}
            </Stack>
          ),
        })),
        ...invitations.map((invitation) => ({
          title: invitation.email,
          body: t("identity.features.memberships.ui.accountTeamPage.invitation.summary", {
            role: membershipRoleLabel(invitation.role_key),
            status: invitationStatusLabel(invitation.status),
          }),
          action:
            invitation.status === "pending" ? (
              <Stack direction="row" gap={2}>
                <Form spacing="none" method="post">
                  <HiddenInput type="hidden" name="intent" value="resend-invitation" readOnly />
                  <HiddenInput type="hidden" name="invitationId" value={invitation.invitation_id} readOnly />
                  <Button type="submit" tone="secondary">
                    {t("identity.features.memberships.ui.accountTeamPage.resend")}
                  </Button>
                </Form>
                <ModalDialog
                  title={t("identity.features.memberships.ui.accountTeamPage.cancel.confirm.title", {
                    email: invitation.email,
                  })}
                  description={t("identity.features.memberships.ui.accountTeamPage.cancel.confirm.description", {
                    email: invitation.email,
                    account: invitationAccountLabel(invitation),
                  })}
                  trigger={
                    <Button type="button" tone="danger">
                      {t("identity.features.memberships.ui.accountTeamPage.cancel")}
                    </Button>
                  }
                >
                  <Form spacing="none" method="post">
                    <HiddenInput type="hidden" name="intent" value="cancel-invitation" readOnly />
                    <HiddenInput type="hidden" name="invitationId" value={invitation.invitation_id} readOnly />
                    <Button type="submit" tone="danger">
                      {t("identity.features.memberships.ui.accountTeamPage.cancel.confirm.action")}
                    </Button>
                  </Form>
                </ModalDialog>
              </Stack>
            ) : null,
        })),
      ]}
    />
  );
}
