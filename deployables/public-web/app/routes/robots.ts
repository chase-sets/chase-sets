import type { LoaderFunctionArgs } from "react-router";
import { resolvePublicOrigin } from "../seo";

export function loader(_args: LoaderFunctionArgs) {
  const origin = resolvePublicOrigin();
  const body = [
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${origin}/sitemap.xml`,
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
