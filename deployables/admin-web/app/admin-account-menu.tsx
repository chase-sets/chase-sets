import { t } from "@chase-sets/localization";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { AccountMenu, Form, type AccountMenuPreferences } from "@chase-sets/design-system";

const signOutFormId = "admin-account-menu-sign-out";

function formatActorLabel(value: string | undefined, fallback: string) {
  if (!value) {
    return fallback;
  }

  return (
    value
      .replace(/^acc(?:ount)?[_-]/i, "")
      .replace(/^usr|^user[_-]/i, "")
      .replace(/[_-]+/g, " ")
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || fallback
  );
}

export function AdminAccountMenu({
  actor,
  preferences,
}: Readonly<{ actor: ResolvedActor; preferences?: AccountMenuPreferences }>) {
  return (
    <>
      <Form id={signOutFormId} action="/access/sign-out" method="post" spacing="none" />
      <AccountMenu
        accountLabel={t("adminWeb.app.adminSectionLayout.account")}
        accountName={formatActorLabel(actor.accountId, t("adminWeb.app.adminSectionLayout.admin.account"))}
        items={[
          {
            key: "account-select",
            label: t("adminWeb.app.adminSectionLayout.switch.account"),
            href: "/access/account-select",
            icon: "user",
          },
          {
            key: "sessions",
            label: t("adminWeb.app.adminSectionLayout.sessions"),
            href: "/access/sessions",
            icon: "clock",
          },
        ]}
        menuLabel={t("adminWeb.app.adminSectionLayout.account.menu")}
        preferences={preferences}
        roleLabel={t("adminWeb.app.adminSectionLayout.role")}
        roleName={formatActorLabel(actor.roleKey, t("adminWeb.app.adminSectionLayout.operator"))}
        signOutFormId={signOutFormId}
        signOutLabel={t("adminWeb.app.adminSectionLayout.sign.out")}
        userLabel={t("adminWeb.app.adminSectionLayout.user")}
        userName={formatActorLabel(actor.userId, t("adminWeb.app.adminSectionLayout.admin.user"))}
      />
    </>
  );
}
