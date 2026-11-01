import type { WebContextRegistry } from "@chase-sets/platform-runtime/web";

import commercialTermsManifest from "@chase-sets/commercial-terms/context";
import pricingManifest from "@chase-sets/pricing/context";
import publicPresenceManifest from "@chase-sets/public-presence/context";

export const webContextRegistry = [
  {
    contextName: "commercial-terms",
    packageName: "@chase-sets/commercial-terms",
    manifest: commercialTermsManifest as WebContextRegistry[number]["manifest"],
  },
  {
    contextName: "pricing",
    packageName: "@chase-sets/pricing",
    manifest: pricingManifest as WebContextRegistry[number]["manifest"],
  },
  {
    contextName: "public-presence",
    packageName: "@chase-sets/public-presence",
    manifest: publicPresenceManifest as WebContextRegistry[number]["manifest"],
  },
] as const satisfies WebContextRegistry;
