import { Outlet, useLoaderData, useLocation } from "react-router";
import { t } from "@chase-sets/localization";
import type { CurrentActorDisplay, IdentityShellViewer } from "@chase-sets/identity/server";
import { useUserPreferencesAccountMenu } from "@chase-sets/identity/web";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import { AdminShell, ChaseRoot, Text } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { type ActiveKeyConfig, resolveActiveKey } from "./admin-section-active-key";
import { AdminAccountMenu } from "./admin-account-menu";
import { resolveAdminWebNavItems, resolveAdminWebSectionNavItems } from "./host";

type SectionConfig = Readonly<{
  section: WebHostSection;
  brand: string;
  fallbackPermission: string;
}> &
  ActiveKeyConfig;

type AdminSectionLoaderData = Readonly<{
  actor: ResolvedActor;
  actorDisplay?: CurrentActorDisplay | null;
  viewer?: IdentityShellViewer;
}>;

export function AdminSectionLayout({ config }: Readonly<{ config: SectionConfig }>) {
  const location = useLocation();
  const { actor, actorDisplay, viewer } = useLoaderData() as AdminSectionLoaderData;
  const { colorMode, preferences } = useUserPreferencesAccountMenu(viewer?.preferences?.colorMode);

  return (
    <ChaseRoot
      colorMode={colorMode}
      reducedMotion={viewer?.preferences?.reducedMotion}
      linkComponent={RouterLinkAdapter}
    >
      <AdminShell
        brand={<Text weight="semibold">{config.brand}</Text>}
        topNavItems={resolveAdminWebSectionNavItems(actor)}
        topNavActiveKey={config.section}
        activeKey={resolveActiveKey(location.pathname, config)}
        navItems={resolveAdminWebNavItems(actor, { section: config.section })}
        actions={<AdminAccountMenu actor={actor} actorDisplay={actorDisplay} preferences={preferences} />}
        moreLabel={t("adminWeb.app.adminShell.more")}
        sectionsLabel={t("adminWeb.app.adminShell.sections")}
        currentSectionLabel={t("adminWeb.app.adminShell.current.section")}
      >
        <Outlet />
      </AdminShell>
    </ChaseRoot>
  );
}
