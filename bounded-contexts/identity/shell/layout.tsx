import { useState, type ReactNode } from "react";
import {
  AdminShell,
  ChaseRoot,
  Text,
  type ColorMode,
} from "@chase-sets/design-system";
import { identityAdminNavItems } from "./nav";

export function IdentityAdminLayout({
  activeKey,
  children,
}: {
  activeKey: string;
  children: ReactNode;
}) {
  const [colorMode] = useState<ColorMode>("system");

  return (
    <ChaseRoot colorMode={colorMode}>
      <AdminShell
        brand={<Text weight="semibold">Identity Admin</Text>}
        navItems={identityAdminNavItems}
        activeKey={activeKey}
      >
        {children}
      </AdminShell>
    </ChaseRoot>
  );
}
