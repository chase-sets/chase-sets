import { t } from "@chase-sets/localization";
import type { IdentityShellViewer } from "@chase-sets/identity/server";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { ReactNode } from "react";
import { AdminShell, ChaseRoot, Text, type NavigationItem } from "@chase-sets/design-system";
import { AdminAccountMenu } from "./admin-account-menu";

export function AdminRootShell({
  actor,
  children,
  sections = [],
  viewer,
}: Readonly<{
  actor?: ResolvedActor | null;
  children: ReactNode;
  sections?: NavigationItem[];
  viewer?: IdentityShellViewer | null;
}>) {
  const resolvedActor = viewer?.actor ?? actor ?? null;
  const colorMode = viewer?.preferences?.colorMode ?? "system";

  return (
    <ChaseRoot colorMode={colorMode}>
      <AdminShell
        brand={<Text weight="semibold">{t("adminWeb.app.root.brand")}</Text>}
        topNavItems={sections}
        navItems={[]}
        actions={resolvedActor ? <AdminAccountMenu actor={resolvedActor} /> : undefined}
      >
        {children}
      </AdminShell>
    </ChaseRoot>
  );
}
