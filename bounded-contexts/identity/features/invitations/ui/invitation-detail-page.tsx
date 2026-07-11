import { t } from "@chase-sets/localization";
import {
  AdminResourceDetailPage,
  HiddenInput,
  Form,
  Button,
  DateInput,
  Inline,
  Stack,
} from "@chase-sets/design-system";
import type { Invitation } from "./contracts";

export function InvitationDetailPage({ data }: { data: Invitation }) {
  const account = data.account_display_name ?? data.account_name ?? data.account_id;
  const acceptedBy =
    data.accepted_by_user_display_name ??
    data.accepted_by_user_primary_email ??
    data.accepted_by_user_id ??
    t("identity.features.invitations.ui.invitationDetailPage.pending");

  return (
    <AdminResourceDetailPage
      breadcrumbs={[
        { label: t("identity.features.invitations.ui.invitationListPage.invitations"), href: "/access/invitations" },
        { label: data.email },
      ]}
      title={data.email}
      status={data.status}
      actions={
        <Inline gap={2}>
          {data.status === "pending" ? (
            <>
              <Form spacing="none" method="post">
                <Stack direction="row" align="end" gap={2}>
                  <HiddenInput type="hidden" name="intent" value="resend" readOnly />
                  <DateInput
                    name="expiresAt"
                    label={t("identity.features.invitations.ui.invitationDetailPage.expires.at")}
                    defaultValue={data.expires_at.slice(0, 10)}
                    required
                  />
                  <Button type="submit" tone="secondary">
                    {t("identity.features.invitations.ui.invitationDetailPage.resend")}
                  </Button>
                </Stack>
              </Form>
              <Form spacing="none" method="post">
                <HiddenInput type="hidden" name="intent" value="cancel" readOnly />
                <Button type="submit" tone="danger">
                  {t("identity.features.invitations.ui.invitationDetailPage.cancel")}
                </Button>
              </Form>
              <Form spacing="none" method="post">
                <HiddenInput type="hidden" name="intent" value="decline" readOnly />
                <Button type="submit" tone="secondary">
                  {t("identity.features.invitations.ui.invitationDetailPage.decline")}
                </Button>
              </Form>
            </>
          ) : null}
        </Inline>
      }
      sections={[
        { label: t("identity.features.invitations.ui.invitationDetailPage.invitation.id"), value: data.invitation_id },
        { label: t("identity.features.invitations.ui.invitationDetailPage.account"), value: account },
        { label: t("identity.features.invitations.ui.invitationDetailPage.role"), value: data.role_key },
        { label: t("identity.features.invitations.ui.invitationDetailPage.expires.at"), value: data.expires_at },
        { label: t("identity.features.invitations.ui.invitationDetailPage.accepted.by"), value: acceptedBy },
      ]}
    />
  );
}
