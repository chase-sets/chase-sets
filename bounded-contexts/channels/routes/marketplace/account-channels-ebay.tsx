import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { createEbayConnectionClient } from "../../features/ebay-connection/ui/api-client";
import { EbayConnectionJourney, type EbayJourneyState } from "../../features/ebay-connection/ui/connection-journey";
import { createChannelsConnectionsRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "channels.manage" });
  const url = new URL(request.url),
    client = createEbayConnectionClient(request);
  const publication = url.searchParams.get("publication") === "true";
  const connectionId = url.searchParams.get("connectionId");
  const consent = await client(`/consent?publication=${publication}`);
  if (
    !consent ||
    typeof consent !== "object" ||
    !Array.isArray(Reflect.get(consent, "scopes")) ||
    Reflect.get(consent, "scopes").some((scope: unknown) => typeof scope !== "string")
  )
    throw new Response(null, { status: 503 });
  let state: EbayJourneyState = "consent";
  if (["declined", "failed"].includes(url.searchParams.get("outcome") ?? ""))
    state = url.searchParams.get("outcome") as "declined" | "failed";
  if (connectionId) {
    const connection = await client(`/connections/${encodeURIComponent(connectionId)}`);
    if (!connection || typeof connection !== "object") throw new Response(null, { status: 404 });
    const status: unknown = Reflect.get(connection, "status");
    if (status === "active") state = "connected";
    else if (status === "paused") state = "reauthorize";
    else if (status === "pending-setup" || status === "disconnected") state = status;
    else throw new Response(null, { status: 503 });
  }
  return { state, scopes: Reflect.get(consent, "scopes") as string[], connectionId, publication };
}
export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "channels.manage" });
  const form = await request.formData(),
    connectionId = String(form.get("connectionId") ?? "") || null;
  try {
    if (form.get("intent") === "disconnect" && connectionId) {
      await createChannelsConnectionsRequestApiClient(request).disconnectConnection(connectionId);
      return redirect(`/account/channels/ebay?connectionId=${encodeURIComponent(connectionId)}`);
    }
    if (form.get("intent") !== "authorize" || !["true", "false"].includes(String(form.get("publication"))))
      return { failed: true };
    const result = await createEbayConnectionClient(request)("/start", {
      connectionId,
      publication: form.get("publication") === "true",
    });
    if (!result || typeof result !== "object" || typeof Reflect.get(result, "authorizationUrl") !== "string")
      throw new Error();
    const url = new URL(Reflect.get(result, "authorizationUrl"));
    if (url.origin !== "https://auth.sandbox.ebay.com" || url.pathname !== "/oauth2/authorize") throw new Error();
    return redirect(url.toString(), { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch {
    return { failed: true };
  }
}
export default function EbayConnectionRoute() {
  const data = useLoaderData<typeof loader>(),
    actionData = useActionData<typeof action>(),
    navigation = useNavigation();
  return (
    <EbayConnectionJourney
      {...data}
      state={navigation.state === "submitting" ? "awaiting-callback" : actionData?.failed ? "failed" : data.state}
    />
  );
}
