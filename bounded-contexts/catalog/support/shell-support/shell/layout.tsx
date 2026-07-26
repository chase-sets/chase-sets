import { t } from "@chase-sets/localization";
import { useState, type ReactNode } from "react";
import { AdminShell, ChaseRoot, SellerBadge, type ColorMode, type NavigationItem } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { CatalogAdminProviders } from "./providers";

export function CatalogAdminLayout({
  topNavItems,
  topNavActiveKey,
  activeKey,
  navItems,
  actions,
  children,
}: {
  topNavItems?: readonly NavigationItem[];
  topNavActiveKey?: string;
  activeKey: string;
  navItems: readonly NavigationItem[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [colorMode] = useState<ColorMode>("system");

  return (
    <ChaseRoot colorMode={colorMode} linkComponent={RouterLinkAdapter}>
      <CatalogAdminProviders>
        <AdminShell
          brand={<SellerBadge name={t("catalog.support.shellSupport.shell.layout.catalog.ops")} verified />}
          topNavItems={topNavItems ? [...topNavItems] : []}
          topNavActiveKey={topNavActiveKey}
          navItems={[...navItems]}
          activeKey={activeKey}
          actions={actions}
          moreLabel={t("adminWeb.app.adminShell.more")}
          sectionsLabel={t("adminWeb.app.adminShell.sections")}
          currentSectionLabel={t("adminWeb.app.adminShell.current.section")}
        >
          {children}
        </AdminShell>
      </CatalogAdminProviders>
    </ChaseRoot>
  );
}
