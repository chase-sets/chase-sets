import type { LoaderFunctionArgs } from "react-router";
import { requireMarketplaceProofAccess } from "../proof-access.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireMarketplaceProofAccess(request);

  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
