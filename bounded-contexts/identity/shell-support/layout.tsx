import { useState, type ReactNode } from "react";
import {
  AdminShell,
  ChaseRoot,
  Text,
  type ColorMode,
  type NavigationItem,
} from "@chase-sets/design-system";

export function IdentityAdminLayout({
  activeKey,
  navItems,
  actions,
  children,
}: {
  activeKey: string;
  navItems: readonly NavigationItem[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [colorMode] = useState<ColorMode>("system");

  return (
    <ChaseRoot colorMode={colorMode}>
      <AdminShell
        brand={<Text weight="semibold">Identity Admin</Text>}
        navItems={[...navItems]}
        activeKey={activeKey}
        actions={actions}
      >
        {children}
      </AdminShell>
    </ChaseRoot>
  );
}
