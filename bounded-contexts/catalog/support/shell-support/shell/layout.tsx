import { t } from "@chase-sets/localization";
import { useState, type ReactNode } from "react";
import { AdminShell, ChaseRoot, SellerBadge, type ColorMode, type NavigationItem } from "@chase-sets/design-system";
import { CatalogAdminProviders } from "./providers";

export function CatalogAdminLayout({
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
      <CatalogAdminProviders>
        <AdminShell
          brand={<SellerBadge name={t("catalog.support.shellSupport.shell.layout.catalog.ops")} verified />}
          navItems={[...navItems]}
          activeKey={activeKey}
          actions={actions}
        >
          {children}
        </AdminShell>
      </CatalogAdminProviders>
    </ChaseRoot>
  );
}
