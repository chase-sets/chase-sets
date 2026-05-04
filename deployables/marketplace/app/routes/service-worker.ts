import type { LoaderFunctionArgs } from "react-router";
import { marketplaceServiceWorkerSource } from "../pwa/service-worker-source";

export function loader(_args: LoaderFunctionArgs) {
  return new Response(marketplaceServiceWorkerSource, {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
    },
  });
}
