import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";

export default [
  route("sign-in", "routes/sign-in.tsx"),
  route("account-select", "routes/account-select.tsx"),
  layout("routes/layout.tsx", [
    index("routes/index.tsx"),
    route("dimensions", "routes/dimensions.tsx"),
    route("dimensions/:id", "routes/dimensions-detail.tsx"),
    route("fields", "routes/fields.tsx"),
    route("fields/:id", "routes/fields-detail.tsx"),
    route("components", "routes/components.tsx"),
    route("components/:id", "routes/components-detail.tsx"),
    route("blueprints", "routes/blueprints.tsx"),
    route("blueprints/:id", "routes/blueprints-detail.tsx"),
    route("categories", "routes/categories.tsx"),
    route("categories/:id", "routes/categories-detail.tsx"),
    route("catalog-items", "routes/catalog-items.tsx"),
    route("catalog-items/:id", "routes/catalog-items-detail.tsx"),
  ]),
] satisfies RouteConfig;
