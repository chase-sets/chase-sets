import { t } from "@chase-sets/localization";
import { Button, Inline, NativeSelect, Stack } from "@chase-sets/design-system";
import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { Membership } from "./contracts";

export function MembershipDetailPage({ data }: { data: Membership }) {
  const user = data.user_display_name ?? data.user_primary_email ?? data.user_id;
  const account = data.account_display_name ?? data.account_name ?? data.account_id;

  return (
    <AdminDetailPage
      title={t("identity.features.memberships.ui.membershipDetailPage.title", { user, account })}
      status={data.status}
      actions={
        <Inline gap={2}>
          <form method="post">
            <Stack direction="row" align="end" gap={2}>
              <input type="hidden" name="intent" value="change-role" readOnly />
              <NativeSelect
                name="roleKey"
                label={t("identity.features.memberships.ui.membershipDetailPage.role")}
                defaultValue={data.role_key}
                items={[
                  { value: "owner", label: t("identity.features.memberships.ui.role.owner") },
                  { value: "manager", label: t("identity.features.memberships.ui.role.manager") },
                  { value: "fulfillment", label: t("identity.features.memberships.ui.role.fulfillment") },
                  { value: "viewer", label: t("identity.features.memberships.ui.role.viewer") },
                ]}
              />
              <Button type="submit" tone="secondary">
                {t("identity.features.memberships.ui.membershipDetailPage.change.role")}
              </Button>
            </Stack>
          </form>
          {data.status === "active" ? (
            <form method="post">
              <input type="hidden" name="intent" value="revoke" readOnly />
              <Button type="submit" tone="danger">
                {t("identity.features.memberships.ui.membershipDetailPage.revoke")}
              </Button>
            </form>
          ) : (
            <form method="post">
              <input type="hidden" name="intent" value="reinstate" readOnly />
              <Button type="submit" tone="primary">
                {t("identity.features.memberships.ui.membershipDetailPage.reinstate")}
              </Button>
            </form>
          )}
        </Inline>
      }
      sections={[
        { label: t("identity.features.memberships.ui.membershipDetailPage.membership.id"), value: data.membership_id },
        { label: t("identity.features.memberships.ui.membershipDetailPage.user"), value: user },
        { label: t("identity.features.memberships.ui.membershipDetailPage.account"), value: account },
        { label: t("identity.features.memberships.ui.membershipDetailPage.role"), value: data.role_key },
        { label: t("identity.features.memberships.ui.membershipDetailPage.updated.at"), value: data.updated_at },
      ]}
    />
  );
}
