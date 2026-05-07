import type { LoaderFunctionArgs } from "react-router";
import { resolvePublicOrigin } from "../seo";

const STABLE_PUBLIC_PATHS = [
  "/",
  "/faq",
  "/contact",
  "/terms",
  "/privacy",
  "/refunds-and-returns",
  "/buyer-protection",
  "/seller-fees",
];

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function loader(_args: LoaderFunctionArgs) {
  const origin = resolvePublicOrigin();
  const urls = STABLE_PUBLIC_PATHS.map((path) => {
    const loc = escapeXml(new URL(path, origin).toString());

    return `<url><loc>${loc}</loc></url>`;
  }).join("");
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
  ].join("");

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
