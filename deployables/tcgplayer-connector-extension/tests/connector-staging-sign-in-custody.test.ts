import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { scanRetainedArtifacts } from "../e2e/retained-artifacts";
import { drillBrowserEnvironment } from "../e2e/pairing-drill";
import {
  createStagingPersonaSignIn,
  stagingPersonaResponseByteLimit,
  STAGING_PERSONA_MAGIC_LINK_SECRET_ENV,
} from "../e2e/pairing-drill-staging";

const origin = "https://marketplace.staging.chasesets.com";
const bearer = "cs_stg_persona_synthetic_secret";
const token = "memory-only-token";
const link = `${origin}/sign-in/magic?token=${token}`;
const now = Date.parse("2026-11-02T12:00:00.000Z");
const expiresAt = new Date(now + 600_000).toISOString();
const directories: string[] = [];

afterEach(() => {
  delete process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}connector-staging-custody-`))
      throw new Error("custody-fixture-path-refused");
    rmSync(directory, { recursive: true, force: true });
  }
});

function context(status = 200) {
  const goto = vi.fn(async () => undefined);
  const requestGet = vi.fn(async () => ({ ok: () => status === 200, status: () => status }));
  const page = { goto };
  return {
    value: { request: { get: requestGet }, pages: () => [page] },
    goto,
    requestGet,
  } as const;
}

describe("staging persona sign-in custody", () => {
  it("excludes the raw bearer and unrelated secrets from Chromium's minimal environment", () => {
    expect(
      drillBrowserEnvironment({
        PATH: "synthetic-path",
        [STAGING_PERSONA_MAGIC_LINK_SECRET_ENV]: bearer,
        UNRELATED_SECRET: "synthetic-unrelated-secret",
      }),
    ).toEqual({ PATH: "synthetic-path" });
  });
  it("reads and deletes the bearer before issuance, probes without a token, then opens the pinned link", async () => {
    process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV]).toBeUndefined();
      expect(init.headers).toMatchObject({ authorization: `Bearer ${bearer}`, origin });
      return new Response(
        JSON.stringify({
          alias: "card-vault",
          link: `${origin}/sign-in/magic?token=memory-only-token`,
          expiresAt,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = context();

    const signIn = createStagingPersonaSignIn();
    expect(process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV]).toBeUndefined();
    const receipt = await signIn(input.value as never, "card-vault");
    expect(receipt).toEqual({
      alias: "card-vault",
      host: new URL(origin).host,
      issuanceStatus: 200,
      landingStatus: 200,
      expiresAt,
      outcome: "used",
    });

    expect(process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV]).toBeUndefined();
    expect(input.requestGet).toHaveBeenCalledWith(`${origin}/sign-in/magic`, {
      headers: { accept: "text/html" },
      maxRedirects: 0,
      timeout: 10_000,
    });
    expect(input.goto).toHaveBeenCalledWith(`${origin}/sign-in/magic?token=memory-only-token`);
    expect(input.requestGet.mock.invocationCallOrder[0]).toBeLessThan(input.goto.mock.invocationCallOrder[0]);
    await expect(signIn(input.value as never, "card-vault")).rejects.toMatchObject({
      code: "connector-drill-sign-in-unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it.each([
    ["stale", { expiresAt: new Date(now).toISOString() }],
    ["malformed expiry", { expiresAt: "not-a-date" }],
    ["over ten minutes", { expiresAt: new Date(now + 600_001).toISOString() }],
    ["foreign link", { link: "https://foreign.invalid/sign-in/magic?token=synthetic" }],
    ["wrong path", { link: `${origin}/other?token=synthetic` }],
    ["extra query", { link: `${link}&redirect=foreign` }],
    ["empty token", { link: `${origin}/sign-in/magic?token=` }],
    ["wrong alias", { alias: "not-a-persona" }],
  ])("refuses %s before probe or navigation", async (_name, change) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ alias: "card-vault", link, expiresAt, ...change })),
    );
    const input = context();
    await expect(createStagingPersonaSignIn()(input.value as never, "card-vault")).rejects.toMatchObject({
      code: "connector-drill-sign-in-unavailable",
      evidence: { signIn: { outcome: "refused", issuanceStatus: 200 } },
    });
    expect(input.requestGet).not.toHaveBeenCalled();
    expect(input.goto).not.toHaveBeenCalled();
  });

  it.each([401, 403, 409, 429, 500])("refuses issuance status %s without browser use", async (status) => {
    process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
    vi.stubGlobal("fetch", async () => new Response("{}", { status }));
    const input = context();
    await expect(createStagingPersonaSignIn()(input.value as never, "card-vault")).rejects.toMatchObject({
      evidence: { signIn: { issuanceStatus: status, landingStatus: null } },
    });
    expect(input.requestGet).not.toHaveBeenCalled();
    expect(input.goto).not.toHaveBeenCalled();
  });

  it.each(["issuance", "probe"])("sanitizes a thrown %s failure without navigation", async (phase) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
    vi.stubGlobal("fetch", async () => {
      if (phase === "issuance") throw new Error(`${bearer} ${link}`);
      return new Response(JSON.stringify({ alias: "card-vault", link, expiresAt }));
    });
    const input = context();
    if (phase === "probe") input.requestGet.mockRejectedValue(new Error(`${bearer} ${link}`));
    const error = await createStagingPersonaSignIn()(input.value as never, "card-vault").catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code: "connector-drill-sign-in-unavailable" });
    for (const marker of [bearer, token, link]) expect(JSON.stringify(error)).not.toContain(marker);
    expect(input.goto).not.toHaveBeenCalled();
  });

  it("refuses a non-ok probe without consuming", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const response = () => new Response(JSON.stringify({ alias: "card-vault", link, expiresAt }));
    vi.stubGlobal("fetch", async () => response());
    process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
    const input = context(503);
    await expect(createStagingPersonaSignIn()(input.value as never, "card-vault")).rejects.toMatchObject({
      evidence: { signIn: { landingStatus: 503, outcome: "refused" } },
    });
    expect(input.goto).not.toHaveBeenCalled();
  });

  it("refuses expiry during the pre-use probe without consuming", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ alias: "card-vault", link, expiresAt })));
    process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
    const late = context();
    late.requestGet.mockImplementation(async () => {
      vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
      return { ok: () => true, status: () => 200 };
    });
    await expect(createStagingPersonaSignIn()(late.value as never, "card-vault")).rejects.toMatchObject({
      code: "connector-drill-sign-in-unavailable",
    });
    expect(late.goto).not.toHaveBeenCalled();
  });

  it("accepts the largest schema body and bounds cap+1 and endless bodies", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const largest = { alias: "sealed-stockroom", link: `${origin}/sign-in/magic?token=${"x".repeat(256)}`, expiresAt };
    expect(Buffer.byteLength(JSON.stringify(largest))).toBe(stagingPersonaResponseByteLimit);
    process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(largest)));
    await expect(createStagingPersonaSignIn()(context().value as never, "sealed-stockroom")).resolves.toMatchObject({
      outcome: "used",
    });
    process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
    vi.stubGlobal("fetch", async () => new Response("x".repeat(stagingPersonaResponseByteLimit + 1)));
    const input = context();
    await expect(createStagingPersonaSignIn()(input.value as never, "card-vault")).rejects.toMatchObject({
      code: "connector-drill-sign-in-unavailable",
    });
    process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(100));
            },
            cancel,
          }),
        ),
    );
    await expect(createStagingPersonaSignIn()(input.value as never, "card-vault")).rejects.toMatchObject({
      code: "connector-drill-sign-in-unavailable",
    });
    expect(cancel).toHaveBeenCalled();
    expect(input.goto).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "scans clean captured success/failure output and detects a planted leak (failure=%s)",
    async (failure) => {
      const output: string[] = [];
      for (const method of ["log", "info", "warn", "error", "debug"] as const)
        vi.spyOn(console, method).mockImplementation((...args) => {
          output.push(args.join(" "));
        });
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      vi.spyOn(Date, "now").mockReturnValue(now);
      process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ alias: "card-vault", link, expiresAt })));
      let artifact: unknown;
      try {
        artifact = await createStagingPersonaSignIn()(context(failure ? 503 : 200).value as never, "card-vault");
      } catch (error) {
        artifact = { code: (error as { code: string }).code, evidence: (error as { evidence: unknown }).evidence };
      }
      const directory = mkdtempSync(join(tmpdir(), "connector-staging-custody-"));
      directories.push(directory);
      const forbidden = [bearer, token, link, "Bearer cs_stg_persona_", "?token="];
      writeFileSync(join(directory, "output.log"), output.join("\n"));
      writeFileSync(join(directory, "receipt.json"), JSON.stringify(artifact));
      expect(scanRetainedArtifacts(directory, forbidden)).toBe(2);
      for (const value of forbidden) expect(output.join("\n")).not.toContain(value);
      writeFileSync(join(directory, "planted-leak-control.txt"), token);
      expect(() => scanRetainedArtifacts(directory, forbidden)).toThrow("connector-retained-artifact-secret");
    },
  );
});
