import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { chromium, test, expect } from "@playwright/test";
import { TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";
import { Hono } from "hono";
import { module as authModule } from "@chase-sets/auth";
import { stagingFakePlatform, stagingSynthetic, synthetic } from "./loopback-platform";
import {
  deployedRequiredIssues,
  digestConnectorDist,
  PairingDrillRefusal,
  providerEnvironmentPattern,
  type PairingDrillDeployBinding,
} from "./pairing-drill";
import {
  createStagingPersonaSignIn,
  runStagingDrill,
  STAGING_PERSONA_MAGIC_LINK_SECRET_ENV,
} from "./pairing-drill-staging";
import { scanRetainedArtifacts } from "./retained-artifacts";

test.use({ trace: "off", screenshot: "off", video: "off" });
test.describe.configure({ mode: "serial" });
const origin = "https://marketplace.staging.chasesets.com";
const bearer = "cs_stg_persona_synthetic_composed";
const token = "synthetic-persona-memory-only-token";
const commit = `${"0".repeat(39)}1`;
const restored = new Map<string, string | undefined>();
let dist: string;
let digest: string;
const binding = (): PairingDrillDeployBinding => ({
  runId: "1",
  runAttempt: 1,
  jobId: "1",
  jobCompletedAt: "2026-01-01T00:00:00Z",
  deployedHead: commit,
  requiredMerges: deployedRequiredIssues.pairing.map((issue) => ({
    issue,
    pullRequest: issue,
    mergeCommit: "0".repeat(40),
    contained: true,
  })),
  receiptFloorRunId: "1",
});

test.beforeAll(async () => {
  for (const key of Object.keys(process.env))
    if (providerEnvironmentPattern.test(key)) {
      restored.set(key, process.env[key]);
      delete process.env[key];
    }
  for (const key of [
    "VITE_PLATFORM_API_URL",
    "PLATFORM_API_URL",
    "VITE_CONNECTOR_CLIENT_ID",
    STAGING_PERSONA_MAGIC_LINK_SECRET_ENV,
  ])
    restored.set(key, process.env[key]);
  delete process.env.VITE_PLATFORM_API_URL;
  delete process.env.PLATFORM_API_URL;
  process.env.VITE_CONNECTOR_CLIENT_ID = stagingSynthetic.clientId;
  dist = mkdtempSync(join(tmpdir(), "connector-persona-composed-dist-"));
  const root = resolve(import.meta.dirname, "..");
  await build({
    root,
    configFile: resolve(root, "vite.config.ts"),
    configLoader: "runner",
    mode: "connector-staging",
    build: { outDir: dist, emptyOutDir: true },
    logLevel: "warn",
  });
  digest = digestConnectorDist(dist);
});
test.afterAll(() => {
  for (const [key, value] of restored) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dist && resolve(dist).startsWith(join(resolve(tmpdir()), "connector-persona-composed-dist-")))
    rmSync(dist, { recursive: true, force: true });
});

type Control = "success" | "unlisted" | "new-alias" | "expired" | "probe" | "missing-origin" | "wrong-host" | "trace";
type AuthServices = Parameters<typeof authModule.buildApis>[0];
async function composed(control: Control) {
  const authRows: { phase: string; host: string; path: string; status: number; code: string | null }[] = [];
  let writes = 0;
  const router = authModule.buildApis({
    stagingPersonaMagicLinkVerifierSha256: createHash("sha256").update(bearer).digest("hex"),
    db: {
      query: async () => {
        writes++;
        return { rows: [] };
      },
    },
    auth: {
      issueOpaqueToken: () => token,
      hashSecret: (value: string) => createHash("sha256").update(value).digest("hex"),
    },
    identity: {
      getUser: async () => ({
        status: "active",
        auth_methods: ["magic-link"],
        primary_email: "synthetic@chasesets.test",
      }),
      getActiveMembershipForUserAccount: async () => ({ status: "active" }),
    },
  } as unknown as AuthServices)[0]!.router;
  if (!(router instanceof Hono)) throw new Error("synthetic-auth-router-unavailable");
  const fake = await stagingFakePlatform({
    pairingPanel: ({ state, pairingId, revision }) =>
      `<p>${state}</p><form method="post"><input type="hidden" name="intent" value="connector-code"><button type="submit">Generate</button></form>${state === "code" || state === "paired" ? `<form method="post"><input type="hidden" name="intent" value="connector-unpair"><input type="hidden" name="pairingId" value="${pairingId}"><input type="hidden" name="revision" value="${revision}"><button type="submit">Unpair</button></form>` : ""}`,
    async handle(request, reply) {
      const url = new URL(request.url!, origin);
      if (url.pathname === "/api/auth/staging-persona-sign-in") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers))
          if (typeof value === "string") headers.set(key, value);
        // Synthetic boundary-corruption controls exercise the real responder guards, not caller-thrown errors.
        if (control === "missing-origin") headers.delete("origin");
        if (control === "wrong-host") headers.set("host", "admin.staging.chasesets.com");
        // The TLS fake listens on a nonstandard port; its resolver preserves the declared staging authority.
        if (control !== "wrong-host") headers.set("host", new URL(origin).host);
        const response = await router.request(`${origin}/staging-persona-sign-in`, { method: "POST", headers, body });
        const payload = (await response.json()) as Record<string, unknown>;
        authRows.push({
          phase: "issuance",
          host: headers.get("host")!,
          path: url.pathname,
          status: response.status,
          code: typeof payload.error === "string" ? payload.error : null,
        });
        if (control === "expired" && response.ok) payload.expiresAt = new Date(Date.now() - 1).toISOString();
        reply
          .writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify(payload));
        return true;
      }
      if (url.pathname === "/sign-in/magic") {
        const consume = url.searchParams.has("token");
        const status = control === "probe" ? 503 : consume ? 302 : 200;
        authRows.push({
          phase: consume ? "consume" : "probe",
          host: new URL(origin).host,
          path: url.pathname,
          status,
          code: null,
        });
        reply
          .writeHead(
            status,
            consume
              ? {
                  Location: "/account/channels",
                  "Set-Cookie": `${synthetic.cookieName}=${synthetic.cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax`,
                }
              : { "Content-Type": "text/html" },
          )
          .end("<!doctype html><title>Sign in</title>");
        return true;
      }
      return false;
    },
  });
  const outputDir = test.info().outputPath(`persona-${control}`);
  process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV] = bearer;
  const signIn = createStagingPersonaSignIn(fake.resolver);
  expect(process.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV]).toBeUndefined();
  const alias = control === "unlisted" ? "not-a-persona" : control === "new-alias" ? "new-persona" : "card-vault";
  try {
    const outcome = await runStagingDrill(
      [
        "--deploy-run",
        "1",
        "--deploy-commit",
        commit,
        "--platform-origin",
        origin,
        "--client-id",
        stagingSynthetic.clientId,
        "--artifact-digest",
        digest,
        "--persona-alias",
        alias,
      ],
      {
        resolveDeployBinding: async () => ({ binding: binding() }),
        signIn,
        dist,
        outputDir,
        resolver: fake.resolver,
        fakeDocuments: fake.documents,
        secretMarkers: [bearer, token, synthetic.cookieValue],
        traceActive: control === "trace",
        launch: (path, options) => {
          expect(options.env[STAGING_PERSONA_MAGIC_LINK_SECRET_ENV]).toBeUndefined();
          expect(Object.values(options.env)).not.toContain(bearer);
          return chromium.launchPersistentContext(path, options);
        },
      },
    ).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    const evidence =
      outcome.error instanceof PairingDrillRefusal
        ? { code: outcome.error.code, evidence: outcome.error.evidence }
        : outcome.result;
    writeFileSync(test.info().outputPath(`persona-${control}.json`), JSON.stringify({ evidence, authRows }));
    expect(
      scanRetainedArtifacts(test.info().outputDir, [bearer, token, ...fake.forbidden(), "?token="]),
    ).toBeGreaterThan(0);
    return { ...outcome, authRows, writes, outputDir };
  } finally {
    await fake.close();
  }
}

for (const control of ["unlisted", "new-alias", "expired", "probe", "missing-origin", "wrong-host"] as const)
  test(`composed staging command observes ${control} refusal from the real-guard Auth responder`, async () => {
    const outcome = await composed(control);
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(PairingDrillRefusal);
    expect((outcome.error as PairingDrillRefusal).code).toBe("connector-drill-sign-in-unavailable");
    expect(outcome.authRows[0]).toMatchObject({
      phase: "issuance",
      status: ["expired", "probe"].includes(control) ? 200 : 403,
    });
    expect(outcome.authRows.some((row) => row.phase === "consume")).toBe(false);
    if (!["expired", "probe"].includes(control)) expect(outcome.writes).toBe(0);
    if (control === "probe") expect(outcome.authRows.at(-1)).toMatchObject({ phase: "probe", status: 503 });
  });

test("active trace refuses before issuance", async () => {
  const outcome = await composed("trace");
  expect(outcome.error).toBeInstanceOf(PairingDrillRefusal);
  expect((outcome.error as PairingDrillRefusal).code).toBe("connector-drill-trace-active");
  expect(outcome.authRows).toEqual([]);
  expect(outcome.writes).toBe(0);
});

test("composed fake receipt carries only redacted sign-in fields and staging cookies/requests", async () => {
  const outcome = await composed("success");
  expect(outcome.error).toBeUndefined();
  const receipt = outcome.result!.receipt;
  expect(receipt.origin).toBe("fake");
  expect(receipt.signIn).toEqual({
    alias: "card-vault",
    host: new URL(origin).host,
    issuanceStatus: 200,
    landingStatus: 200,
    expiresAt: expect.any(String),
    outcome: "used",
  });
  expect(receipt.cookies.every((row) => row.domain === new URL(origin).hostname)).toBe(true);
  const intercepted = new Set([
    ...receipt.aborted.map((row) => row.origin),
    new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI).origin,
  ]);
  expect(
    receipt.requests.every(
      (row) => row.origin === origin || row.origin.startsWith("chrome-extension://") || intercepted.has(row.origin),
    ),
  ).toBe(true);
  expect(receipt.requests.some((row) => /(^|\.)tcgplayer\.com$/i.test(new URL(row.origin).hostname))).toBe(false);
  expect(readFileSync(join(outcome.outputDir, "receipt.json"), "utf8")).not.toContain(bearer);
});
