import { t } from "@chase-sets/localization";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import {
  displayActorAccountName,
  displayActorUserName,
  displayRole,
  type CurrentActorDisplay,
} from "@chase-sets/identity/web";
import { AccountMenu, Form, type AccountMenuPreferences } from "@chase-sets/design-system";

const signOutFormId = "admin-account-menu-sign-out";

export function AdminAccountMenu({
  actor,
  actorDisplay,
  preferences,
}: Readonly<{
  actor: ResolvedActor;
  actorDisplay?: CurrentActorDisplay | null;
  preferences?: AccountMenuPreferences;
}>) {
  const accountName = actorDisplay
    ? displayActorAccountName(actorDisplay)
    : t("adminWeb.app.adminSectionLayout.admin.account");
  const userName = actorDisplay ? displayActorUserName(actorDisplay) : t("adminWeb.app.adminSectionLayout.admin.user");
  const roleKey = actorDisplay?.membership.role_key || actor.roleKey;
  const roleName = roleKey ? displayRole(roleKey) : t("adminWeb.app.adminSectionLayout.operator");

  return (
    <>
      <Form id={signOutFormId} action="/access/sign-out" method="post" spacing="none" />
      <AccountMenu
        accountLabel={t("adminWeb.app.adminSectionLayout.account")}
        accountName={accountName}
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
        roleName={roleName}
        signOutFormId={signOutFormId}
        signOutLabel={t("adminWeb.app.adminSectionLayout.sign.out")}
        userLabel={t("adminWeb.app.adminSectionLayout.user")}
        userName={userName}
      />
    </>
  );
}
