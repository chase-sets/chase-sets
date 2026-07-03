import { createServiceWorkerRoute } from "@chase-sets/platform-runtime/pwa";
import { adminServiceWorkerSource } from "../pwa/service-worker-source";

export const loader = createServiceWorkerRoute(adminServiceWorkerSource);
