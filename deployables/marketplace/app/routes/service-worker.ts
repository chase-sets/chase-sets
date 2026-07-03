import { createServiceWorkerRoute } from "@chase-sets/platform-runtime/pwa";
import { marketplaceServiceWorkerSource } from "../pwa/service-worker-source";

export const loader = createServiceWorkerRoute(marketplaceServiceWorkerSource);
