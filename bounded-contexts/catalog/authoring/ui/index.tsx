import type { ReactNode } from "react";
import type { NavigationItem } from "@chase-sets/design-system";
import { Text } from "@chase-sets/design-system";
import { ToastProvider } from "../shared/ui/toasts";
import { DimensionListPage } from "../dimensions/ui/dimension-list-page";
import { DimensionDetailPage } from "../dimensions/ui/dimension-detail-page";
import { FieldListPage } from "../fields/ui/field-list-page";
import { FieldDetailPage } from "../fields/ui/field-detail-page";
import { ComponentListPage } from "../components/ui/component-list-page";
import { ComponentDetailPage } from "../components/ui/component-detail-page";
import { BlueprintListPage } from "../blueprints/ui/blueprint-list-page";
import { BlueprintDetailPage } from "../blueprints/ui/blueprint-detail-page";
import { CategoryListPage } from "../categories/ui/category-list-page";
import { CategoryDetailPage } from "../categories/ui/category-detail-page";
import { CatalogItemListPage } from "../catalog-items/ui/catalog-item-list-page";
import { CatalogItemDetailPage } from "../catalog-items/ui/catalog-item-detail-page";

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

