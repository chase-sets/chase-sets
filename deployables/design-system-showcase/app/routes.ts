import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";

export default [
  layout("routes/layout.tsx", [
    index("routes/marketplace.tsx"),
    route("admin", "routes/admin.tsx"),
    route("checkout", "routes/checkout.tsx"),
    route("components", "routes/components.tsx"),
  ]),
] satisfies RouteConfig;
