import type { ChannelOAuthTokenSet } from "../../credentials/domain/contracts";
import type { EbayOAuthConfiguration } from "../domain/configuration";
import { EbayConnectionError, parseIdentity, parseTokenResponse } from "../domain/oauth";

export interface EbayOAuthProvider {
  exchange(code: string, signal: AbortSignal): Promise<ChannelOAuthTokenSet>;
  identity(accessToken: string, signal: AbortSignal): Promise<string>;
  revoke(refreshToken: string, signal: AbortSignal): Promise<number>;
}
export function createEbayOAuthProvider(
  config: EbayOAuthConfiguration,
  transport: typeof fetch = globalThis.fetch,
): EbayOAuthProvider {
  const basic = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  async function request(url: string, init: RequestInit) {
    try {
      return await transport(url, { ...init, redirect: "error", cache: "no-store" });
    } catch {
      throw new EbayConnectionError("provider-unavailable");
    }
  }
  async function json(response: Response) {
    if (!response.ok || !response.body) throw new EbayConnectionError("provider-unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) {
          await reader.cancel();
          throw new EbayConnectionError("invalid-provider-response");
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new EbayConnectionError("invalid-provider-response");
    } finally {
      for (const chunk of chunks) chunk.fill(0);
      reader.releaseLock();
    }
  }
  return {
    async exchange(code, signal) {
      const response = await request("https://api.sandbox.ebay.com/identity/v1/oauth2/token", {
        method: "POST",
        signal,
        headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.ruName }),
      });
      return parseTokenResponse(await json(response), new Date().toISOString());
    },
    async identity(accessToken, signal) {
      return parseIdentity(
        await json(
          await request("https://apiz.sandbox.ebay.com/commerce/identity/v1/user/", {
            signal,
            headers: { authorization: `Bearer ${accessToken}` },
          }),
        ),
      );
    },
    async revoke(refreshToken, signal) {
      const response = await request("https://api.sandbox.ebay.com/identity/v1/oauth2/token/revoke", {
        method: "POST",
        signal,
        headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token" }),
      });
      await response.body?.cancel();
      return response.status;
    },
  };
}

export async function revokeCurrentGrant(provider: EbayOAuthProvider | null, refreshToken: string | null) {
  if (!provider || !refreshToken) return "unconfirmed" as const;
  const signal = AbortSignal.timeout(10000);
  for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
    try {
      const status = await provider.revoke(refreshToken, signal);
      if (status !== 429 && status < 500) break;
    } catch {
      break;
    }
  }
  // S1's HTTP 200 did not disable refresh; no captured response proves remote revocation.
  return "unconfirmed" as const;
}
