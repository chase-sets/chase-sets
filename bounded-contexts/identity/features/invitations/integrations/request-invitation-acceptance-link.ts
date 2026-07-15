import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { appendFreshWriteTokenFromSources } from "@chase-sets/http/responses";

export async function requestInvitationAcceptanceLink(
  request: Request,
  invitationId: string,
  freshWriteSource: unknown,
) {
  const requestUrl = new URL(request.url);
  const freshPath = appendFreshWriteTokenFromSources(`${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`, [
    freshWriteSource,
  ]);
  const freshRequest = new Request(new URL(freshPath, requestUrl.origin), { headers: request.headers });
  const baseUrl = resolveRequestApiBaseUrl(freshRequest, "/api/auth", { requireInternalApiOrigin: true });
  const response = await createForwardedAuthFetch(freshRequest, globalThis.fetch, { readTargetContextName: "auth" })(
    new URL("invitations/acceptance-link/request", `${baseUrl}/`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId, landingPath: `/invite/${encodeURIComponent(invitationId)}` }),
    },
  );
  if (!response.ok) {
    throw new Error("The invitation was saved, but its acceptance email could not be sent.");
  }
}
