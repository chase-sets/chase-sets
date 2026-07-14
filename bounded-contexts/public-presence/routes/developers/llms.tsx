import type { LoaderFunctionArgs } from "react-router";
import {
  buildDeveloperLlmsTxt,
  developerPortalResponseHeaders,
  requireDeveloperPortalReady,
} from "../../features/developer-portal/ui/developer-route-data";

function resolveOrigin(request: Request) {
  return process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin;
}

export function loader({ request }: LoaderFunctionArgs) {
  requireDeveloperPortalReady();
  return new Response(buildDeveloperLlmsTxt(resolveOrigin(request)), {
    headers: {
      ...developerPortalResponseHeaders,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export default function DeveloperLlmsRoute() {
  return null;
}
