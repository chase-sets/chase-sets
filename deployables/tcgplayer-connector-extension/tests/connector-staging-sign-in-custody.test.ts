import { afterEach, describe, expect, it, vi } from "vitest";
import { createStagingPersonaSignIn, STAGING_PERSONA_MAGIC_LINK_SECRET_ENV } from "../e2e/pairing-drill-staging";

const origin = "https://marketplace.staging.chasesets.com";
const bearer = "cs_stg_persona_synthetic_secret";

afterEach(() => {
  delete process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV];
  vi.unstubAllGlobals();
});

function context() {
  const goto = vi.fn(async () => undefined);
  const requestGet = vi.fn(async () => ({ ok: () => true }));
  const page = { goto };
  return {
    value: { request: { get: requestGet }, pages: () => [page] },
    goto,
    requestGet,
  } as const;
}

describe("staging persona sign-in custody", () => {
  it("reads and deletes the bearer before issuance, probes without a token, then opens the pinned link", async () => {
    process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ authorization: `Bearer ${bearer}`, origin });
      return new Response(
        JSON.stringify({
          alias: "card-vault",
          link: `${origin}/sign-in/magic?token=memory-only-token`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = context();

    await createStagingPersonaSignIn()(input.value as never, "card-vault");

    expect(process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV]).toBeUndefined();
    expect(input.requestGet).toHaveBeenCalledWith(`${origin}/sign-in/magic`, {
      headers: { accept: "text/html" },
    });
    expect(input.goto).toHaveBeenCalledWith(`${origin}/sign-in/magic?token=memory-only-token`);
  });

  it("refuses missing bearer, failed probe, and cross-origin links without navigating", async () => {
    const input = context();
    await expect(createStagingPersonaSignIn()(input.value as never, "card-vault")).rejects.toMatchObject({
      code: "connector-drill-sign-in-unavailable",
    });

    process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ alias: "card-vault", link: "https://evil.example/sign-in/magic?token=x" }), {
            status: 200,
          }),
      ),
    );
    await expect(createStagingPersonaSignIn()(input.value as never, "card-vault")).rejects.toMatchObject({
      code: "connector-drill-sign-in-unavailable",
    });
    expect(input.goto).not.toHaveBeenCalled();
  });
});
