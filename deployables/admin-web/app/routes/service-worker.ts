import type { LoaderFunctionArgs } from "react-router";
import { adminServiceWorkerSource } from "../pwa/service-worker-source";

export function loader(_args: LoaderFunctionArgs) {
  return new Response(adminServiceWorkerSource, {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
    },
  });
}
