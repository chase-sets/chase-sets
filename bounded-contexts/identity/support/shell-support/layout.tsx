import { t } from "@chase-sets/localization";
import { useState, type ReactNode } from "react";
import {
  AdminShell,
  ChaseRoot,
  SellerBadge,
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
        brand={<SellerBadge name={t("identity.support.shellSupport.layout.identity.ops")} verified />}
        navItems={[...navItems]}
        activeKey={activeKey}
        actions={actions}
      >
        {children}
      </AdminShell>
    </ChaseRoot>
  );
}
