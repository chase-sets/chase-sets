import { closed, isGrant, operatorOrigins, type OperatorEnvironment } from "./protocol";

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
  return { revoke };
}
