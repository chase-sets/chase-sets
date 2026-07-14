import type { LoaderFunctionArgs } from "react-router";
import {
  buildDeveloperManifest,
  developerPortalResponseHeaders,
  requireDeveloperPortalReady,
} from "../../features/developer-portal/ui/developer-route-data";

function resolveOrigin(request: Request) {
  return process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin;
}

export function loader({ request }: LoaderFunctionArgs) {
  requireDeveloperPortalReady();
  return Response.json(buildDeveloperManifest(resolveOrigin(request)), {
    headers: developerPortalResponseHeaders,
  });
}

export default function DeveloperManifestRoute() {
  return null;
}
