import { Suspense } from "react";
import { Await, useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { t } from "@chase-sets/localization";
import { requireProviderConnectionsActor } from "../../features/provider-connections/api/access";
import { loadProviderConnections } from "../../features/provider-connections/api/client";
import { ProviderConnectionsPage } from "../../features/provider-connections/ui/provider-connections-page";

export const meta: MetaFunction = () => [{ title: t("platformOperations.providerConnections.metaTitle") }];

export async function loader({ request }: LoaderFunctionArgs) {
  requireProviderConnectionsActor(await resolveActorFromAuthApi({ request }));
  return { snapshot: loadProviderConnections(request) };
}

export default function ProviderConnectionsRoute() {
  const { snapshot } = useLoaderData<typeof loader>();
  return (
    <Suspense fallback={<ProviderConnectionsPage />}>
      <Await resolve={snapshot} errorElement={<ProviderConnectionsPage failed />}>
        {(resolved) => <ProviderConnectionsPage snapshot={resolved} />}
      </Await>
    </Suspense>
  );
}
