import { useState } from "react";
import { Outlet, useLoaderData, useLocation } from "react-router";
import { t } from "@chase-sets/localization";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import { AccountMenu, AdminShell, ChaseRoot, Form, Text, type ColorMode } from "@chase-sets/design-system";
import { resolveAdminWebNavItems, resolveAdminWebSectionNavItems } from "./host";

type SectionConfig = Readonly<{
  section: WebHostSection;
  brand: string;
  fallbackPermission: string;
  defaultActiveKey: string;
  activeKeys?: Readonly<Record<string, string>>;
}>;

type AdminSectionLoaderData = Readonly<{
  actor: ResolvedActor;
}>;

const signOutFormId = "admin-account-menu-sign-out";

function resolveActiveKey(pathname: string, config: SectionConfig) {
  const segments = pathname.split("/").filter(Boolean);
  const sectionPath = segments[1] ?? "";
  return config.activeKeys?.[sectionPath] ?? (sectionPath || config.defaultActiveKey);
}

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

export function AdminSectionLayout({ config }: Readonly<{ config: SectionConfig }>) {
  const location = useLocation();
  const { actor } = useLoaderData() as AdminSectionLoaderData;
  const [colorMode] = useState<ColorMode>("system");

  return (
    <ChaseRoot colorMode={colorMode}>
      <AdminShell
        brand={<Text weight="semibold">{config.brand}</Text>}
        topNavItems={resolveAdminWebSectionNavItems(actor)}
        topNavActiveKey={config.section}
        activeKey={resolveActiveKey(location.pathname, config)}
        navItems={resolveAdminWebNavItems(actor, { section: config.section })}
        actions={
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
              roleLabel={t("adminWeb.app.adminSectionLayout.role")}
              roleName={formatActorLabel(actor.roleKey, t("adminWeb.app.adminSectionLayout.operator"))}
              signOutFormId={signOutFormId}
              signOutLabel={t("adminWeb.app.adminSectionLayout.sign.out")}
              userLabel={t("adminWeb.app.adminSectionLayout.user")}
              userName={formatActorLabel(actor.userId, t("adminWeb.app.adminSectionLayout.admin.user"))}
            />
          </>
        }
      >
        <Outlet />
      </AdminShell>
    </ChaseRoot>
  );
}
