import type { LoaderFunctionArgs } from "react-router";
import { requireMarketplaceProofAccess } from "../proof-access.server";
import { buildMarketplaceRobotsTxt, shouldIndexMarketplace } from "../seo";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireMarketplaceProofAccess(request);

  const origin = new URL(request.url).origin;
  const body = buildMarketplaceRobotsTxt({ origin, shouldIndex: shouldIndexMarketplace() });

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
