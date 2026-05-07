import type { LoaderFunctionArgs } from "react-router";

export function loader(_args: LoaderFunctionArgs) {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
