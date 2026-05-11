import type { LoaderFunctionArgs } from "react-router";

export function loader({ request }: LoaderFunctionArgs) {
  return Response.json({
    ok: true,
    service: "marketplace",
    checkedAt: new Date().toISOString(),
    origin: new URL(request.url).origin,
  });
}
