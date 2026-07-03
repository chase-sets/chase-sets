import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { adminAuthHost } from "../../support/route-support/auth-host.server";
import { adminAuthHostConfig } from "../../support/route-support/host-config";
import {
  createMagicLinkLandingLoader,
  MagicLinkLandingPage,
  type MagicLinkLandingLoaderData,
} from "../../support/route-support/magic-link-landing";

export const meta: MetaFunction = () => [{ title: adminAuthHostConfig.titles.signIn }];

export const loader = createMagicLinkLandingLoader({
  authHost: adminAuthHost,
  signInPath: adminAuthHostConfig.signInPath,
});

export default function AccessAdminMagicLinkLandingRoute() {
  const data = useLoaderData<typeof loader>() as MagicLinkLandingLoaderData;
  return <MagicLinkLandingPage data={data} />;
}
