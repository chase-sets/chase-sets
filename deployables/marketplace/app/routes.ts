import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";
import { contextRoutes } from "./context-routes.generated";

export default [
  route("favicon.ico", "routes/favicon.ts"),
  route(
    ".well-known/appspecific/com.chrome.devtools.json",
    "routes/chrome-devtools.ts",
  ),
  route("robots.txt", "routes/robots.ts"),
  route("sitemap.xml", "routes/sitemap.ts"),
  layout("routes/layout.tsx", [
    index("routes/index.tsx"),
    route("sign-in", "routes/sign-in.tsx"),
    route("sign-out", "routes/sign-out.tsx"),
    route("register", "routes/register.tsx"),
    route("account/select", "routes/account-select.tsx"),
    ...contextRoutes,
  ]),
] satisfies RouteConfig;
