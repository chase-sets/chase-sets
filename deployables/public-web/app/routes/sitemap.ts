import type { LoaderFunctionArgs } from "react-router";
import { buildSitemapXml } from "@chase-sets/platform-runtime/seo";
import { resolvePublicOrigin } from "../seo";

const STABLE_PUBLIC_PATHS = [
  "/",
  "/faq",
  "/contact",
  "/terms",
  "/privacy",
  "/refunds-and-returns",
  "/order-protection",
  "/sales-fees",
];

export function loader(_args: LoaderFunctionArgs) {
  const origin = resolvePublicOrigin();
  const body = buildSitemapXml(
    origin,
    STABLE_PUBLIC_PATHS.map((path) => ({ path })),
  );

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
