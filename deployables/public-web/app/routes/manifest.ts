import { publicPresenceT as t } from "@chase-sets/public-presence/web";
import type { LoaderFunctionArgs } from "react-router";

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
    theme_color: "#1d5fd6",
    background_color: "#f8fafc",
    icons: [],
  } as const;
}

export function loader(_args: LoaderFunctionArgs) {
  return Response.json(buildPublicManifest(), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/manifest+json; charset=utf-8",
    },
  });
}
