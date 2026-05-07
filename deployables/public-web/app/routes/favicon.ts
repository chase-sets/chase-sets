import type { LoaderFunctionArgs } from "react-router";
import { chaseSetsLogoSvg } from "@chase-sets/design-system";

export function loader(_args: LoaderFunctionArgs) {
  return new Response(chaseSetsLogoSvg, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": "image/svg+xml; charset=utf-8",
    },
  });
}
