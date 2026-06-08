import { useState } from "react";
import { Outlet, useLoaderData, useLocation } from "react-router";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import { AdminShell, Button, ChaseRoot, Form, Inline, SellerBadge, type ColorMode } from "@chase-sets/design-system";
import { resolveAdminWebNavItems, resolveAdminWebSectionNavItems } from "./host";

type SectionConfig = Readonly<{
  section: WebHostSection;
  brand: string;
  fallbackPermission: string;
  defaultActiveKey: string;
  activeKeys?: Readonly<Record<string, string>>;
}>;

type AdminSectionLoaderData = Readonly<{
  actor: Readonly<{ permissions?: readonly string[] }>;
}>;

function resolveActiveKey(pathname: string, config: SectionConfig) {
  const segments = pathname.split("/").filter(Boolean);
  const sectionPath = segments[1] ?? "";
  return config.activeKeys?.[sectionPath] ?? sectionPath ?? config.defaultActiveKey;
}

export function AdminSectionLayout({ config }: Readonly<{ config: SectionConfig }>) {
  const location = useLocation();
  const { actor } = useLoaderData() as AdminSectionLoaderData;
  const [colorMode] = useState<ColorMode>("system");

  return (
    <ChaseRoot colorMode={colorMode}>
      <AdminShell
        brand={<SellerBadge name={config.brand} verified />}
        topNavItems={resolveAdminWebSectionNavItems(actor)}
        topNavActiveKey={config.section}
        activeKey={resolveActiveKey(location.pathname, config)}
        navItems={resolveAdminWebNavItems(actor, { section: config.section })}
        actions={
          <Inline gap={2}>
            <Form action="/access/sign-out" method="post" spacing="none">
              <Button type="submit" tone="secondary">
                Sign out
              </Button>
            </Form>
          </Inline>
        }
      >
        <Outlet />
      </AdminShell>
    </ChaseRoot>
  );
}
