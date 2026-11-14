import { closed, isGrant, operatorOrigins, type OperatorEnvironment } from "./protocol";
import { isSetNamesPostMessage, isSetNamesPostResult, type SetNamesPostResult } from "./set-names/transport";
import type { TcgplayerSetNameObservationPost } from "./set-names/contract";

export type OperatorResult = { outcome: "revoked" | "grant-invalid" | "unavailable" | "refused" | "invalid-response" };
export function createOperatorTransport(fetcher: typeof fetch) {
  async function revoke(environment: OperatorEnvironment, grant: string): Promise<OperatorResult> {
    if (!isGrant(grant)) return { outcome: "refused" };
    try {
      const response = await fetcher(`${operatorOrigins[environment]}/api/public/catalog/operator-session/grant`, {
        method: "DELETE",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: { Authorization: `Bearer ${grant}` },
      });
      if (response.status === 401) return { outcome: "grant-invalid" };
      if (response.status >= 500) return { outcome: "unavailable" };
      const body: unknown = await response.json();
      return response.status === 200 && closed(body, ["outcome"]) && body.outcome === "revoked"
        ? { outcome: "revoked" }
        : { outcome: "invalid-response" };
    } catch {
      return { outcome: "unavailable" };
    }
  }
  async function postSetNames(
    environment: OperatorEnvironment,
    grant: string,
    post: TcgplayerSetNameObservationPost,
  ): Promise<SetNamesPostResult> {
    if (!isGrant(grant) || !isSetNamesPostMessage({ action: "post-set-names", environment, post }))
      return { outcome: "refused" };
    try {
      const response = await fetcher(
        `${operatorOrigins[environment]}/api/public/catalog/operator-session/scope-observations/tcgplayer-set-names`,
        {
          method: "POST",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          headers: { Authorization: `Bearer ${grant}`, "Content-Type": "application/json" },
          body: JSON.stringify(post),
        },
      );
      if (response.status === 401 || response.status === 403) return { outcome: "grant-invalid" };
      if (response.status >= 500) return { outcome: "unavailable" };
      if (response.status !== 200) return { outcome: "refused" };
      const body: unknown = await response.json();
      if (!closed(body, ["observationCount", "newObservationCount", "mappingsProposed"]))
        return { outcome: "invalid-response" };
      const result = { outcome: "recorded", ...body };
      return isSetNamesPostResult(result) ? result : { outcome: "invalid-response" };
    } catch {
      return { outcome: "unavailable" };
    }
  }
  return { revoke, postSetNames };
}
