import type { LoaderFunctionArgs } from "react-router";

export function loader({ request }: LoaderFunctionArgs) {
  return Response.json({
    ok: true,
    service: "admin-web",
    checkedAt: new Date().toISOString(),
    origin: new URL(request.url).origin,
  });
}
