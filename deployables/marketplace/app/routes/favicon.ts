import type { LoaderFunctionArgs } from "react-router";

const faviconSvg = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
  '<rect width="64" height="64" rx="12" fill="#111827"/>',
  '<path d="M18 20h28v8H26v8h16v8H26v10h-8V20Z" fill="#f8fafc"/>',
  "</svg>",
].join("");

export function loader(_args: LoaderFunctionArgs) {
  return new Response(faviconSvg, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": "image/svg+xml; charset=utf-8",
    },
  });
}
