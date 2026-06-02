import type { LoaderFunctionArgs } from "react-router";
import { requireMarketplaceProofAccess } from "../proof-access.server";
import { shouldIndexMarketplace } from "../seo";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireMarketplaceProofAccess(request);

  const origin = new URL(request.url).origin;
  const body = shouldIndexMarketplace()
    ? ["User-agent: *", "Allow: /", `Sitemap: ${origin}/sitemap.xml`].join("\n")
    : ["User-agent: *", "Disallow: /"].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
