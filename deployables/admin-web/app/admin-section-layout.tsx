import { useState } from "react";
import { Outlet, useLoaderData, useLocation } from "react-router";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import { AdminShell, ChaseRoot, Text, type ColorMode } from "@chase-sets/design-system";
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
}>;

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
        actions={<AdminAccountMenu actor={actor} />}
      >
        <Outlet />
      </AdminShell>
    </ChaseRoot>
  );
}
