import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";

export function createEbayConnectionClient(request: Request) {
  const base = resolveRequestApiBaseUrl(request, "/api/channels/ebay");
  const fetch = createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "channels" });
  return async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(
      `${base}${path}`,
      body === undefined
        ? { cache: "no-store" }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            cache: "no-store",
          },
    );
    if (!response.ok) throw new Error("ebay-connection-unavailable");
    return response.json();
  };
}
