import { t } from "@chase-sets/localization";
import { createWebManifestLoader } from "@chase-sets/platform-runtime/pwa";

function buildAdminManifest() {
  return {
    name: "Chase Sets Admin",
    short_name: "CS Admin",
    description: t("adminWeb.app.routes.manifest.description"),
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    categories: ["business", "productivity"],
    theme_color: "#1f6f68",
    background_color: "#f8fafc",
    icons: [
      {
        src: "/icons/chase-sets-admin-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/chase-sets-admin-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/chase-sets-admin-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/chase-sets-admin-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  } as const;
}

export const loader = createWebManifestLoader(buildAdminManifest);
