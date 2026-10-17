import { t } from "@chase-sets/localization";
import { createWebManifestLoader } from "@chase-sets/platform-runtime/pwa";

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
    theme_color: "#4845c6",
    background_color: "#f7f5f1",
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

export const loader = createWebManifestLoader(buildMarketplaceManifest);
