import { useState, type ReactNode } from "react";
import { AdminShell, ChaseRoot, Text, type ColorMode } from "@chase-sets/design-system";
import { CatalogAdminProviders } from "./providers";
import { catalogAdminNavItems } from "./nav";

export function CatalogAdminLayout({
  activeKey,
  children,
}: {
  activeKey: string;
  children: ReactNode;
}) {
  const [colorMode] = useState<ColorMode>("system");

  return (
    <ChaseRoot colorMode={colorMode}>
      <CatalogAdminProviders>
        <AdminShell
          brand={<Text weight="semibold">Catalog Admin</Text>}
          navItems={catalogAdminNavItems}
          activeKey={activeKey}
        >
          {children}
        </AdminShell>
      </CatalogAdminProviders>
    </ChaseRoot>
  );
}
