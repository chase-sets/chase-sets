import { data, redirect, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { AuthApiError } from "../../client";
import { createAuthRequestApiClient, createUcpOAuthRequestApiClient } from "../../support/request-support/api-client";
import { AgentConsentPage } from "../../features/agent-grants/ui/agent-consent-page";

export function headers() {
  return new Headers({
    "Content-Security-Policy": "frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const consentToken = url.searchParams.get("consent_token") ?? "";
  try {
    const result = await createUcpOAuthRequestApiClient(request).getAgentConsent(consentToken);
    return data({ consent: result.consent, consentToken }, { headers: headers() });
  } catch (error) {
    if (error instanceof AuthApiError && error.status === 401) {
      throw redirect(`/sign-in?${new URLSearchParams({ returnTo: `${url.pathname}${url.search}` })}`, {
        headers: headers(),
      });
    }
    if (error instanceof AuthApiError && (error.status === 400 || error.status === 404)) {
      return data({ consent: null, consentToken: "" }, { headers: headers() });
    }
    throw error;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (
    request.headers.get("origin") !== resolvePublicRequestOrigin(request) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    return new Response(null, { status: 403, headers: headers() });
  }
  const form = await request.formData();
  const token = String(form.get("consent_token") ?? "");
  const accountId = String(form.get("accountId") ?? "");
  const { consent } = await createUcpOAuthRequestApiClient(request).getAgentConsent(token);
  if (!consent.memberships.some((membership) => membership.accountId === accountId)) {
    return new Response(null, { status: 403, headers: headers() });
  }
  await createAuthRequestApiClient(request).switchSessionAccount(consent.sessionId, accountId);
  return redirect(consent.authorizePath, { headers: headers() });
}

export default function MarketplaceAccountAgentsConsentRoute() {
  const result = useLoaderData<typeof loader>();
  return <AgentConsentPage consent={result.consent} consentToken={result.consentToken} />;
}
