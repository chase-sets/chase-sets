import type { RouteDelivery } from "@chase-sets/bounded-context-module";

type MarketplaceHostRouteInventoryEntry = Readonly<{
  routePath: string;
  fileExport: string;
  delivery: Exclude<RouteDelivery, "portable">;
  owner: "marketplace-web";
  followUp: string;
  reason: string;
}>;

const webResourceReason = "The route returns a web protocol resource rather than a portable page.";
const webPageReason = "The host-owned page is not a bounded-context portable route.";

const marketplaceHostRoutes = [
  { routePath: "/", fileExport: "routes/index.tsx", delivery: "server-only", reason: webPageReason },
  {
    routePath: "manifest.webmanifest",
    fileExport: "routes/manifest.ts",
    delivery: "web-resource-only",
    reason: webResourceReason,
  },
  {
    routePath: "service-worker.js",
    fileExport: "routes/service-worker.ts",
    delivery: "web-resource-only",
    reason: webResourceReason,
  },
  {
    routePath: "favicon.svg",
    fileExport: "routes/favicon-svg.ts",
    delivery: "web-resource-only",
    reason: webResourceReason,
  },
  {
    routePath: "favicon.ico",
    fileExport: "routes/favicon.ts",
    delivery: "web-resource-only",
    reason: webResourceReason,
  },
  {
    routePath: ".well-known/appspecific/com.chrome.devtools.json",
    fileExport: "routes/chrome-devtools.ts",
    delivery: "web-resource-only",
    reason: webResourceReason,
  },
  { routePath: "robots.txt", fileExport: "routes/robots.ts", delivery: "web-resource-only", reason: webResourceReason },
  {
    routePath: "sitemap.xml",
    fileExport: "routes/sitemap.ts",
    delivery: "web-resource-only",
    reason: webResourceReason,
  },
  {
    routePath: "sitemap/:kind/:page.xml",
    fileExport: "routes/sitemap-entity.ts",
    delivery: "web-resource-only",
    reason: webResourceReason,
  },
  {
    routePath: "health/ready",
    fileExport: "routes/health-ready.ts",
    delivery: "web-resource-only",
    reason: webResourceReason,
  },
  {
    routePath: "health/live",
    fileExport: "routes/health-live.ts",
    delivery: "web-resource-only",
    reason: webResourceReason,
  },
  {
    routePath: "analytics/item-detail-rail",
    fileExport: "routes/item-detail-rail-analytics.ts",
    delivery: "web-resource-only",
    reason: webResourceReason,
  },
  { routePath: "offline", fileExport: "routes/offline.tsx", delivery: "server-only", reason: webPageReason },
  { routePath: "(layout)", fileExport: "routes/layout.tsx", delivery: "server-only", reason: webPageReason },
  { routePath: "*", fileExport: "routes/not-found.tsx", delivery: "server-only", reason: webPageReason },
] satisfies readonly Omit<MarketplaceHostRouteInventoryEntry, "owner" | "followUp">[];

export const marketplaceHostRouteInventory = marketplaceHostRoutes.map((route) => ({
  ...route,
  owner: "marketplace-web",
  followUp: "#5238",
})) satisfies readonly MarketplaceHostRouteInventoryEntry[];
