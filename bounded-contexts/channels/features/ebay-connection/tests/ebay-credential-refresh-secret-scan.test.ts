import { describe, expect, it, vi } from "vitest";
import { createEbayOAuthProvider } from "../api/provider";
import { parseEbayOAuthConfiguration } from "../domain/configuration";
import { parseTokenResponse } from "../domain/oauth";

const marker = "synthetic-secret-token-body-marker";
const config = parseEbayOAuthConfiguration("sandbox", "synthetic-app", "synthetic-secret", "synthetic-runame")!;
const tokens = parseTokenResponse(
  {
    access_token: marker,
    refresh_token: marker,
    expires_in: 7200,
    refresh_token_expires_in: 1000000,
    token_type: "User Access Token",
  },
  new Date().toISOString(),
);
describe("ebay-credential-refresh-secret-scan", () => {
  it("uses the retained refresh grant and captured S1 response shape through the real mapper", async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({ access_token: marker, expires_in: 7200, token_type: "User Access Token" }),
    );
    const provider = createEbayOAuthProvider(config, transport);
    const result = await provider.refresh(tokens, AbortSignal.timeout(1000));
    expect(result.refresh).toEqual(tokens.refresh);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://api.sandbox.ebay.com/identity/v1/oauth2/token");
    expect(init?.redirect).toBe("error");
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      grant_type: "refresh_token",
      refresh_token: marker,
    });
  });
  it.each(["unmapped-refusal", "transport", "malformed-body"])(
    "never exposes token/provider text for %s",
    async (kind) => {
      const provider = createEbayOAuthProvider(config, async () => {
        if (kind === "transport") throw new Error(marker);
        return kind === "unmapped-refusal"
          ? new Response(marker, { status: 400 })
          : Response.json({ error_description: marker });
      });
      try {
        await provider.refresh(tokens, AbortSignal.timeout(1000));
        throw new Error("expected refusal");
      } catch (error) {
        expect(String(error)).not.toContain(marker);
        expect(JSON.stringify(error)).not.toContain(marker);
        expect(error).toMatchObject({
          code: kind === "malformed-body" ? "invalid-provider-response" : "provider-unavailable",
        });
      }
    },
  );
});
