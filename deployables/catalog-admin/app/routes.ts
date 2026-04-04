import {
  index,
  layout,
  type RouteConfig,
} from "@react-router/dev/routes";
import {
  layoutContextRoutes,
  rootContextRoutes,
} from "./context-routes.generated";

export default [
  ...rootContextRoutes,
  layout("routes/layout.tsx", [
    index("routes/index.tsx"),
    ...layoutContextRoutes,
  ]),
] satisfies RouteConfig;
