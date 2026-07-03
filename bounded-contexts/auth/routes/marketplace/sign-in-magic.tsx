import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { marketplaceAuthHostConfig } from "../../support/route-support/host-config";
import { marketplaceAuthHost } from "../../support/route-support/auth-host.server";
import {
  createMagicLinkLandingLoader,
  MagicLinkLandingPage,
  type MagicLinkLandingLoaderData,
} from "../../support/route-support/magic-link-landing";

export const meta: MetaFunction = () => buildOpenGraphMeta({ title: marketplaceAuthHostConfig.titles.signIn });

export const loader = createMagicLinkLandingLoader({
  authHost: marketplaceAuthHost,
  signInPath: marketplaceAuthHostConfig.signInPath,
});

export default function MarketplaceMagicLinkLandingRoute() {
  const data = useLoaderData<typeof loader>() as MagicLinkLandingLoaderData;
  return <MagicLinkLandingPage data={data} />;
}
