import type { LoaderFunctionArgs } from "react-router";
import { buildRobotsTxt } from "@chase-sets/platform-runtime/seo";
import { resolvePublicOrigin, shouldIndexPublicWeb } from "../seo";

export function loader(_args: LoaderFunctionArgs) {
  const origin = resolvePublicOrigin();
  const body = buildRobotsTxt({ origin, shouldIndex: shouldIndexPublicWeb() });

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
