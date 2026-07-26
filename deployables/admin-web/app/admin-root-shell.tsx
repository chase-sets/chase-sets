import { t } from "@chase-sets/localization";
import type { IdentityShellViewer } from "@chase-sets/identity/server";
import type { CurrentActorDisplay } from "@chase-sets/identity/web";
import { useUserPreferencesAccountMenu } from "@chase-sets/identity/web";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { ReactNode } from "react";
import { AdminShell, ChaseRoot, Text, type NavigationItem } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { AdminAccountMenu } from "./admin-account-menu";

export function AdminRootShell({
  actor,
  actorDisplay,
  children,
  sections = [],
  viewer,
}: Readonly<{
  actor?: ResolvedActor | null;
  actorDisplay?: CurrentActorDisplay | null;
  children: ReactNode;
  sections?: NavigationItem[];
  viewer?: IdentityShellViewer | null;
}>) {
  const resolvedActor = viewer?.actor ?? actor ?? null;
  const { colorMode, preferences } = useUserPreferencesAccountMenu(viewer?.preferences?.colorMode);

  return (
    <ChaseRoot
      colorMode={colorMode}
      reducedMotion={viewer?.preferences?.reducedMotion}
      linkComponent={RouterLinkAdapter}
    >
      <AdminShell
        brand={<Text weight="semibold">{t("adminWeb.app.root.brand")}</Text>}
        topNavItems={sections}
        navItems={[]}
        actions={
          resolvedActor ? (
            <AdminAccountMenu actor={resolvedActor} actorDisplay={actorDisplay} preferences={preferences} />
          ) : undefined
        }
        moreLabel={t("adminWeb.app.adminShell.more")}
        sectionsLabel={t("adminWeb.app.adminShell.sections")}
        currentSectionLabel={t("adminWeb.app.adminShell.current.section")}
      >
        {children}
      </AdminShell>
    </ChaseRoot>
  );
}
