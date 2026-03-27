import type { LoaderFunctionArgs } from "react-router";

const STABLE_PUBLIC_PATHS = ["/", "/search"];

export function loader({ request }: LoaderFunctionArgs) {
  const { origin } = new URL(request.url);
  const urls = STABLE_PUBLIC_PATHS.map(
    (pathname) =>
      `<url><loc>${new URL(pathname, origin).toString()}</loc></url>`,
  ).join("");

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
