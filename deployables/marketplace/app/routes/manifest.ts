import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs } from "react-router";

function buildMarketplaceManifest() {
  return {
    name: "Chase Sets",
    short_name: "Chase Sets",
    description: t("marketplace.app.routes.manifest.description"),
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    categories: ["shopping", "productivity"],
    theme_color: "#1d5fd6",
    background_color: "#f8fafc",
    icons: [
      {
        src: "/icons/chase-sets-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/chase-sets-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/chase-sets-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/chase-sets-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  } as const;
}

export function loader(_args: LoaderFunctionArgs) {
  return Response.json(buildMarketplaceManifest(), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/manifest+json; charset=utf-8",
    },
  });
}
