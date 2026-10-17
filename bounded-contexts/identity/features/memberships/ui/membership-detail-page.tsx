import { formatDateTime, t } from "@chase-sets/localization";
import {
  AdminResourceDetailPage,
  HiddenInput,
  Form,
  Button,
  Inline,
  ModalDialog,
  NativeSelect,
  Stack,
} from "@chase-sets/design-system";
import type { Membership } from "./contracts";
import { grantableRoleSelectItems } from "./role-select-items";
import {
  identityDateUnavailable,
  membershipRoleLabel,
  membershipStatusLabel,
} from "../../../support/ui-support/value-labels";

export function MembershipDetailPage({ data }: { data: Membership }) {
  const user = data.user_display_name ?? data.user_primary_email ?? data.user_id;
  const account = data.account_display_name ?? data.account_name ?? data.account_id;

  return (
    <AdminResourceDetailPage
      breadcrumbs={[
        { label: t("identity.features.memberships.ui.membershipListPage.memberships"), href: "/access/memberships" },
        { label: user },
      ]}
      title={t("identity.features.memberships.ui.membershipDetailPage.title", { user, account })}
      status={membershipStatusLabel(data.status)}
      actions={
        <Inline gap={2}>
          <Form spacing="none" method="post">
            <Stack direction="row" align="end" gap={2}>
              <HiddenInput type="hidden" name="intent" value="change-role" readOnly />
              <NativeSelect
                name="roleKey"
                label={t("identity.features.memberships.ui.membershipDetailPage.role")}
                defaultValue={data.role_key}
                items={grantableRoleSelectItems}
              />
              <Button type="submit" tone="secondary">
                {t("identity.features.memberships.ui.membershipDetailPage.change.role")}
              </Button>
            </Stack>
          </Form>
          {data.status === "active" ? (
            <ModalDialog
              title={t("identity.features.memberships.ui.membershipDetailPage.revoke.confirm.title", { user })}
              description={t("identity.features.memberships.ui.membershipDetailPage.revoke.confirm.description", {
                user,
                account,
              })}
              trigger={
                <Button type="button" tone="danger">
                  {t("identity.features.memberships.ui.membershipDetailPage.revoke")}
                </Button>
              }
            >
              <Form spacing="none" method="post">
                <HiddenInput type="hidden" name="intent" value="revoke" readOnly />
                <Button type="submit" tone="danger">
                  {t("identity.features.memberships.ui.membershipDetailPage.revoke.confirm.action")}
                </Button>
              </Form>
            </ModalDialog>
          ) : (
            <Form spacing="none" method="post">
              <HiddenInput type="hidden" name="intent" value="reinstate" readOnly />
              <Button type="submit" tone="primary">
                {t("identity.features.memberships.ui.membershipDetailPage.reinstate")}
              </Button>
            </Form>
          )}
        </Inline>
      }
      sections={[
        { label: t("identity.features.memberships.ui.membershipDetailPage.membership.id"), value: data.membership_id },
        { label: t("identity.features.memberships.ui.membershipDetailPage.user"), value: user },
        { label: t("identity.features.memberships.ui.membershipDetailPage.account"), value: account },
        {
          label: t("identity.features.memberships.ui.membershipDetailPage.role"),
          value: membershipRoleLabel(data.role_key),
        },
        {
          label: t("identity.features.memberships.ui.membershipDetailPage.updated.at"),
          value: formatDateTime(data.updated_at, { fallback: identityDateUnavailable() }),
        },
      ]}
    />
  );
}
