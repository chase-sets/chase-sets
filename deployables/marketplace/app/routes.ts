import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";

export default [
  route("robots.txt", "routes/robots.ts"),
  route("sitemap.xml", "routes/sitemap.ts"),
  layout("routes/layout.tsx", [
    index("routes/index.tsx"),
    route("search", "routes/search.tsx"),
    route("items/:id", "routes/item-detail.tsx"),
  ]),
] satisfies RouteConfig;
