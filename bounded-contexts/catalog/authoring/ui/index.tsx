import type { ReactNode } from "react";
import type { NavigationItem } from "@chase-sets/design-system";
import { Text } from "@chase-sets/design-system";
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

export type CatalogAdminRoute = {
  entity: string;
  id?: string;
};

export const catalogAdminNavItems: NavigationItem[] = [
  { key: "dimensions", label: "Dimensions", icon: "spark" },
  { key: "fields", label: "Fields", icon: "edit" },
  { key: "components", label: "Components", icon: "package" },
  { key: "blueprints", label: "Blueprints", icon: "copy" },
  { key: "categories", label: "Categories", icon: "filter" },
  { key: "catalog-items", label: "Catalog Items", icon: "dashboard" },
];

export function CatalogAdminProviders({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

export function CatalogAdminContent({ route }: { route: CatalogAdminRoute }) {
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
