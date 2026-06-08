import { t } from "@chase-sets/localization";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { ReactNode } from "react";
import { AdminShell, ChaseRoot, Text, type NavigationItem } from "@chase-sets/design-system";
import { AdminAccountMenu } from "./admin-account-menu";

export function AdminRootShell({
  actor,
  children,
  sections = [],
}: Readonly<{
  actor?: ResolvedActor | null;
  children: ReactNode;
  sections?: NavigationItem[];
}>) {
  return (
    <ChaseRoot colorMode="system">
      <AdminShell
        brand={<Text weight="semibold">{t("adminWeb.app.root.brand")}</Text>}
        topNavItems={sections}
        navItems={[]}
        actions={actor ? <AdminAccountMenu actor={actor} /> : undefined}
      >
        {children}
      </AdminShell>
    </ChaseRoot>
  );
}
