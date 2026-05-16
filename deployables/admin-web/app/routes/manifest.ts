import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs } from "react-router";

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

export function loader(_args: LoaderFunctionArgs) {
  return Response.json(buildAdminManifest(), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/manifest+json; charset=utf-8",
    },
  });
}
