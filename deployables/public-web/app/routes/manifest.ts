import { publicPresenceT as t } from "@chase-sets/public-presence/web";
import { createWebManifestLoader } from "@chase-sets/platform-runtime/pwa";

function buildPublicManifest() {
  return {
    name: "Chase Sets",
    short_name: "Chase Sets",
    description: t("publicPresence.home.description"),
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    categories: ["shopping", "productivity"],
    theme_color: "#4845c6",
    background_color: "#f7f5f1",
    icons: [],
  } as const;
}

export const loader = createWebManifestLoader(buildPublicManifest);
