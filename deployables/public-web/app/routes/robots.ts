import type { LoaderFunctionArgs } from "react-router";
import { resolvePublicOrigin, shouldIndexPublicWeb } from "../seo";

export function loader(_args: LoaderFunctionArgs) {
  const origin = resolvePublicOrigin();
  const body = shouldIndexPublicWeb()
    ? [
        "User-agent: *",
        "Allow: /",
        `Sitemap: ${origin}/sitemap.xml`,
      ].join("\n")
    : [
        "User-agent: *",
        "Disallow: /",
      ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
