import { useState } from "react";
import {
  AdminShell,
  ChaseRoot,
  Text,
} from "@chase-sets/design-system";
import type { ColorMode } from "@chase-sets/design-system";
import {
  CatalogAdminContent,
  CatalogAdminProviders,
  catalogAdminNavItems,
} from "../../../bounded-contexts/catalog/authoring";
import { useHashRouter } from "./router";

export function App() {
  const [colorMode] = useState<ColorMode>("system");
  const route = useHashRouter();

  return (
    <ChaseRoot colorMode={colorMode}>
      <CatalogAdminProviders>
        <AdminShell
          brand={<Text weight="semibold">Catalog Admin</Text>}
          navItems={catalogAdminNavItems.map((item) => ({
            ...item,
            href: `#/${item.key}`,
          }))}
          activeKey={route.entity}
        >
          <CatalogAdminContent route={route} />
        </AdminShell>
      </CatalogAdminProviders>
    </ChaseRoot>
  );
}