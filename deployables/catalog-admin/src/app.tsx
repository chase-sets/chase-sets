import { useState } from "react";
import {
  AdminShell,
  ChaseRoot,
  Text,
  type NavigationItem,
} from "@chase-sets/design-system";
import type { ColorMode } from "@chase-sets/design-system";
import { useHashRouter, navigate } from "./router";
import { ToastProvider } from "./toasts";
import { DimensionListPage } from "./entities/dimensions/dimension-list-page";
import { DimensionDetailPage } from "./entities/dimensions/dimension-detail-page";
import { FieldListPage } from "./entities/fields/field-list-page";
import { FieldDetailPage } from "./entities/fields/field-detail-page";
import { ComponentListPage } from "./entities/components/component-list-page";
import { ComponentDetailPage } from "./entities/components/component-detail-page";
import { BlueprintListPage } from "./entities/blueprints/blueprint-list-page";
import { BlueprintDetailPage } from "./entities/blueprints/blueprint-detail-page";
import { CategoryListPage } from "./entities/categories/category-list-page";
import { CategoryDetailPage } from "./entities/categories/category-detail-page";
import { CatalogItemListPage } from "./entities/catalog-items/catalog-item-list-page";
import { CatalogItemDetailPage } from "./entities/catalog-items/catalog-item-detail-page";

const navItems: NavigationItem[] = [
  { key: "dimensions", label: "Dimensions", icon: "spark" },
  { key: "fields", label: "Fields", icon: "edit" },
  { key: "components", label: "Components", icon: "package" },
  { key: "blueprints", label: "Blueprints", icon: "copy" },
  { key: "categories", label: "Categories", icon: "filter" },
  { key: "catalog-items", label: "Catalog Items", icon: "dashboard" },
];

function renderPage(entity: string, id?: string) {
  switch (entity) {
    case "dimensions":
      return id ? <DimensionDetailPage id={id} /> : <DimensionListPage />;
    case "fields":
      return id ? <FieldDetailPage id={id} /> : <FieldListPage />;
    case "components":
      return id ? <ComponentDetailPage id={id} /> : <ComponentListPage />;
    case "blueprints":
      return id ? <BlueprintDetailPage id={id} /> : <BlueprintListPage />;
    case "categories":
      return id ? <CategoryDetailPage id={id} /> : <CategoryListPage />;
    case "catalog-items":
      return id ? <CatalogItemDetailPage id={id} /> : <CatalogItemListPage />;
    default:
      return <Text>Unknown page: {entity}</Text>;
  }
}

export function App() {
  const [colorMode, setColorMode] = useState<ColorMode>("system");
  const route = useHashRouter();

  return (
    <ChaseRoot colorMode={colorMode}>
      <ToastProvider>
        <AdminShell
          brand={<Text weight="semibold">Catalog Admin</Text>}
          navItems={navItems.map((item) => ({
            ...item,
            href: `#/${item.key}`,
          }))}
          activeKey={route.entity}
        >
          {renderPage(route.entity, route.id)}
        </AdminShell>
      </ToastProvider>
    </ChaseRoot>
  );
}
