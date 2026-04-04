import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";
import {
  layoutContextRoutes,
  rootContextRoutes,
} from "./context-routes.generated";

export default [
  ...rootContextRoutes,
  route("favicon.ico", "routes/favicon.ts"),
  route(
    ".well-known/appspecific/com.chrome.devtools.json",
    "routes/chrome-devtools.ts",
  ),
  route("robots.txt", "routes/robots.ts"),
  route("sitemap.xml", "routes/sitemap.ts"),
  layout("routes/layout.tsx", [
    index("routes/index.tsx"),
    ...layoutContextRoutes,
  ]),
] satisfies RouteConfig;
