import { useState } from "react";
import type { ColorMode } from "@chase-sets/design-system";
import { AdminShell, ChaseRoot, Text } from "@chase-sets/design-system";
import { BlueprintDetailPage } from "../blueprints/ui/blueprint-detail-page";
import { BlueprintListPage } from "../blueprints/ui/blueprint-list-page";
import { CatalogItemDetailPage } from "../catalog-items/ui/catalog-item-detail-page";
import { CatalogItemListPage } from "../catalog-items/ui/catalog-item-list-page";
import { CategoryDetailPage } from "../categories/ui/category-detail-page";
import { CategoryListPage } from "../categories/ui/category-list-page";
import { ComponentDetailPage } from "../components/ui/component-detail-page";
import { ComponentListPage } from "../components/ui/component-list-page";
import { DimensionDetailPage } from "../dimensions/ui/dimension-detail-page";
import { DimensionListPage } from "../dimensions/ui/dimension-list-page";
import { FieldDetailPage } from "../fields/ui/field-detail-page";
import { FieldListPage } from "../fields/ui/field-list-page";
import { catalogAdminNavItems } from "./nav";
import { CatalogAdminProviders } from "./providers";
import { useCatalogAdminRouter, type CatalogAdminRoute } from "./router";

function CatalogAdminContent({ route }: { route: CatalogAdminRoute }) {
  switch (route.entity) {
    case "dimensions":
      return route.id ? <DimensionDetailPage id={route.id} /> : <DimensionListPage />;
    case "fields":
      return route.id ? <FieldDetailPage id={route.id} /> : <FieldListPage />;
    case "components":
      return route.id ? <ComponentDetailPage id={route.id} /> : <ComponentListPage />;
    case "blueprints":
      return route.id ? <BlueprintDetailPage id={route.id} /> : <BlueprintListPage />;
    case "categories":
      return route.id ? <CategoryDetailPage id={route.id} /> : <CategoryListPage />;
    case "catalog-items":
      return route.id ? <CatalogItemDetailPage id={route.id} /> : <CatalogItemListPage />;
    default:
      return <Text>Unknown page: {route.entity}</Text>;
  }
}

export function CatalogAdminApp() {
  const [colorMode] = useState<ColorMode>("system");
  const route = useCatalogAdminRouter();

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
