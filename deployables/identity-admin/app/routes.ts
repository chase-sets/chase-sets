import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";
import { contextRoutes } from "./context-routes.generated";

export default [
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-out", "routes/sign-out.tsx"),
  route("account-select", "routes/account-select.tsx"),
  layout("routes/layout.tsx", [
    index("routes/index.tsx"),
    ...contextRoutes,
  ]),
] satisfies RouteConfig;
