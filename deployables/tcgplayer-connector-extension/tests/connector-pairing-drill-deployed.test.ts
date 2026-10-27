import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "@playwright/test";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels";
import {
  cleanDrillProfile,
  deployedBrowserArgs,
  digestConnectorDist,
  drillBrowserEnvironment,
  PairingDrillRefusal,
  providerEnvironmentPattern,
  retainDeployedReceipt,
  type DeployedPairingDrillReceipt,
  type DrillLaunchOptions,
  type PairingDrillDeployBinding,
  type PairingDrillRefusalCode,
} from "../e2e/pairing-drill";
import {
  parseStagingDrillArgs,
  runStagingDrill,
  stagingPreflightRows,
  stagingReceiptComment,
  type DeployBindingResult,
  type StagingDrillPorts,
} from "../e2e/pairing-drill-staging";
import { drillTestCertificate, stagingFakePlatform, stagingSynthetic, synthetic } from "../e2e/loopback-platform";

const staging = linkIntentOrigins["marketplace-web"].staging;
const production = linkIntentOrigins["marketplace-web"].production;
const stagingHost = new URL(staging).host;
const authorizePath = "/channel-connector/oauth/authorize";
const run = "1";
const commit = `${"0".repeat(39)}1`;
let dist: string;
let digest: string;

beforeAll(() => {
  // A synthetic dist that passes the origin, client and digest checks, so a run reaches its launch.
  dist = mkdtempSync(join(tmpdir(), "connector-drill-unit-dist-"));
  writeFileSync(join(dist, "manifest.json"), JSON.stringify({ host_permissions: [`${staging}/*`] }));
  writeFileSync(join(dist, "background.js"), `const clientId = "${stagingSynthetic.clientId}";\n`);
  digest = digestConnectorDist(dist);
});
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const binding = (overrides: Partial<PairingDrillDeployBinding> = {}): PairingDrillDeployBinding => ({
  runId: run,
  runAttempt: 1,
  jobId: "1",
  jobCompletedAt: "2026-01-01T00:00:00Z",
  deployedHead: commit,
  requiredMerges: [10110, 9985, 10639, 10640].map((issue) => ({
    issue,
    pullRequest: issue,
    mergeCommit: "0".repeat(40),
    contained: true,
  })),
  receiptFloorRunId: run,
  ...overrides,
});
const pairingArgs = (overrides: Record<string, string | null> = {}) =>
  Object.entries({
    "--deploy-run": run,
    "--deploy-commit": commit,
    "--platform-origin": staging,
    "--client-id": stagingSynthetic.clientId,
    "--artifact-digest": "",
    "--persona-alias": stagingSynthetic.personaAlias,
    ...overrides,
  }).flatMap(([flag, value]) =>
    value === null ? [] : [flag, flag === "--artifact-digest" && !value ? digest : value],
  );
const smokeArgs = (overrides: Record<string, string | null> = {}) => [
  "--smoke",
  ...Object.entries({
    "--deploy-run": run,
    "--deploy-commit": commit,
    "--platform-origin": staging,
    ...overrides,
  }).flatMap(([flag, value]) => (value === null ? [] : [flag, value])),
];

function refusalCode(action: () => unknown): PairingDrillRefusalCode | "accepted" {
  try {
    action();
    return "accepted";
  } catch (error) {
    if (!(error instanceof PairingDrillRefusal)) throw error;
    return error.code;
  }
}

async function refused(run: Promise<unknown>) {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PairingDrillRefusal);
  return error as PairingDrillRefusal;
}

type Handle = (request: IncomingMessage, reply: ServerResponse) => Promise<boolean>;
/** Serves one replacement authorize response for the matching query shape; everything else stays the fake's. */
const authorizeOverride =
  (shape: "mount" | "client" | "unregistered", status: number, headers: Record<string, string>, body = ""): Handle =>
  async (request, reply) => {
    const url = new URL(request.url!, staging);
    if (url.pathname !== authorizePath) return false;
    const client = url.searchParams.get("client_id");
    const actual = !client ? "mount" : client === stagingSynthetic.clientId ? "client" : "unregistered";
    if (actual !== shape) return false;
    reply.writeHead(status, headers).end(body);
    return true;
  };

async function command(
  argv: readonly string[],
  options: { binding?: DeployBindingResult; signIn?: boolean; handle?: Handle; resolver?: "fake" | "untrusted" } = {},
) {
  const fake = await stagingFakePlatform({ handle: options.handle });
  const resolveDeployBinding = vi.fn(async () => options.binding ?? { binding: binding() });
  const launches: { profilePath: string; options: DrillLaunchOptions }[] = [];
  const launch = vi.fn(async (profilePath: string, launchOptions: DrillLaunchOptions): Promise<BrowserContext> => {
    launches.push({ profilePath, options: launchOptions });
    throw new Error("launch-refused-by-test");
  });
  const resolver =
    options.resolver === "untrusted"
      ? { ...fake.resolver, certificatePem: drillTestCertificate().certificatePem }
      : fake.resolver;
  const outputDir = mkdtempSync(join(tmpdir(), "connector-drill-unit-out-"));
  const ports: StagingDrillPorts = {
    resolveDeployBinding,
    ...(options.signIn === false ? {} : { signIn: async () => undefined }),
    dist,
    outputDir,
    resolver,
    launch,
  };
  try {
    const outcome = await runStagingDrill(argv, ports).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    return { ...outcome, resolveDeployBinding, launches, fake, rows: fake.rows() };
  } finally {
    await fake.close();
    rmSync(outputDir, { recursive: true, force: true });
  }
}
const codeOf = (error: unknown) => (error instanceof PairingDrillRefusal ? error.code : error);

describe("connector-pairing-drill-deployed arguments", () => {
  it("accepts a complete pairing run and a deploy-and-origin-only smoke", () => {
    expect(parseStagingDrillArgs(pairingArgs())).toMatchObject({ smoke: false, deployRun: run, deployCommit: commit });
    expect(parseStagingDrillArgs(["--", ...smokeArgs()])).toEqual({
      smoke: true,
      deployRun: run,
      deployCommit: commit,
      platformOrigin: staging,
      clientId: undefined,
      artifactDigest: undefined,
      personaAlias: undefined,
    });
  });

  it("refuses each missing input, an extra smoke input, unknown or repeated flags and malformed deploy ids", () => {
    const cases: [string, readonly string[], PairingDrillRefusalCode][] = [
      ...[
        "--deploy-run",
        "--deploy-commit",
        "--platform-origin",
        "--client-id",
        "--artifact-digest",
        "--persona-alias",
      ].map((flag): [string, readonly string[], PairingDrillRefusalCode] => [
        `pairing without ${flag}`,
        pairingArgs({ [flag]: null }),
        "connector-drill-input-incomplete",
      ]),
      ...["--deploy-run", "--deploy-commit", "--platform-origin"].map(
        (flag): [string, readonly string[], PairingDrillRefusalCode] => [
          `smoke without ${flag}`,
          smokeArgs({ [flag]: null }),
          "connector-drill-input-incomplete",
        ],
      ),
      ["smoke with a persona", [...smokeArgs(), "--persona-alias", "x"], "connector-drill-input-incomplete"],
      ["unknown flag", [...smokeArgs(), "--trace", "on"], "connector-drill-input-incomplete"],
      ["repeated flag", [...smokeArgs(), "--deploy-run", run], "connector-drill-input-incomplete"],
      [
        "flag without value",
        [...smokeArgs({ "--deploy-run": null }), "--deploy-run"],
        "connector-drill-input-incomplete",
      ],
      ["short commit", smokeArgs({ "--deploy-commit": "abc123" }), "connector-drill-input-incomplete"],
      ["non-decimal run", smokeArgs({ "--deploy-run": "run-1" }), "connector-drill-input-incomplete"],
    ];
    for (const [name, argv, code] of cases)
      expect({ name, code: refusalCode(() => parseStagingDrillArgs(argv)) }).toEqual({ name, code });
  });

  it("refuses production, loopback-only and any other origin", () => {
    for (const argv of [
      pairingArgs({ "--platform-origin": production }),
      smokeArgs({ "--platform-origin": production }),
    ])
      expect(refusalCode(() => parseStagingDrillArgs(argv))).toBe("connector-drill-production-origin-refused");
    for (const origin of ["http://127.0.0.1:46174", `${staging}/`, "https://marketplace.chasesets.example"])
      expect(refusalCode(() => parseStagingDrillArgs(smokeArgs({ "--platform-origin": origin })))).toBe(
        "connector-drill-platform-origin-refused",
      );
  });
});

describe("connector-pairing-drill-deployed preflight rows", () => {
  it("records the mount, no-follow client and unregistered-client rows through the fake's resolver and certificate", async () => {
    const fake = await stagingFakePlatform();
    try {
      const rows = await stagingPreflightRows(staging, stagingSynthetic.clientId, fake.resolver);
      expect(rows).toEqual([
        {
          row: "mount",
          host: stagingHost,
          path: authorizePath,
          status: 400,
          contentType: "application/json",
          bodyCode: "invalid-request",
          locationHost: null,
          errorDescription: null,
        },
        {
          row: "client",
          host: stagingHost,
          path: authorizePath,
          status: 302,
          contentType: null,
          bodyCode: null,
          locationHost: new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI).host,
          errorDescription: "authorization_refused",
        },
        {
          row: "unregistered-client",
          host: stagingHost,
          path: authorizePath,
          status: 400,
          contentType: "application/json",
          bodyCode: "invalid-client",
          locationHost: null,
          errorDescription: null,
        },
      ]);
      // Unauthenticated Node probes: no browser, no session, and the redirect is never followed.
      expect(fake.rows()).toEqual([
        { step: "authorize-mount", method: "GET", browser: false, session: false, status: 400 },
        { step: "authorize-refused", method: "GET", browser: false, session: false, status: 302 },
        { step: "authorize-unregistered", method: "GET", browser: false, session: false, status: 400 },
      ]);
    } finally {
      await fake.close();
    }
  });

  it("trusts only the per-run test certificate, which names only the staging host", async () => {
    const certificate = new X509Certificate(drillTestCertificate().certificatePem);
    expect(certificate.checkHost(new URL(staging).hostname)).toBe(new URL(staging).hostname);
    expect(certificate.checkHost("marketplace.chasesets.com")).toBeUndefined();
    const fake = await stagingFakePlatform();
    try {
      const rows = await stagingPreflightRows(staging, stagingSynthetic.clientId, {
        ...fake.resolver,
        certificatePem: drillTestCertificate().certificatePem,
      });
      expect(rows.map((row) => row.status)).toEqual([0, 0, 0]);
      expect(fake.rows()).toEqual([]);
    } finally {
      await fake.close();
    }
  });
});

describe("connector-pairing-drill-deployed fake staging host", () => {
  it("serves the owned lifecycle in order and refuses a claim once unpaired", async () => {
    const fake = await stagingFakePlatform();
    const { address, port, certificatePem } = fake.resolver;
    const send = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; location: string | null; json: Record<string, unknown> | null }>(
        (resolve, reject) => {
          const request = httpsRequest(
            new URL(path, staging),
            {
              method,
              port,
              ca: certificatePem,
              lookup: ((_host, options, callback) =>
                options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)) as LookupFunction,
              headers: {
                cookie: `${synthetic.cookieName}=${synthetic.cookieValue}`,
                "user-agent": "Chrome/0 drill",
                ...headers,
              },
            },
            (response) => {
              let text = "";
              response.on("data", (chunk) => (text += chunk));
              response.on("end", () => {
                let json: Record<string, unknown> | null = null;
                try {
                  json = JSON.parse(text);
                } catch {
                  json = null;
                }
                resolve({ status: response.statusCode ?? 0, location: response.headers.location ?? null, json });
              });
            },
          );
          request.on("error", reject);
          request.end(body);
        },
      );
    try {
      const { json: connected } = await send("POST", "/api/channels/connections", '{"providerKey":"tcgplayer"}');
      const id = connected!.connectionId as string;
      const api = `/api/channels/connections/${id}`;
      const activated = await send(
        "POST",
        `${api}/activate`,
        JSON.stringify({ storageLocationIds: [stagingSynthetic.storageLocationId] }),
      );
      expect(activated.json?.status).toBe("active");
      expect((await send("POST", `${api}/pause`)).json?.status).toBe("paused");
      const form = { "content-type": "application/x-www-form-urlencoded" };
      expect((await send("POST", `/account/channels/${id}`, "intent=connector-code", form)).status).toBe(303);
      const coded = (await send("GET", `${api}/connector-pairing`)).json!;
      expect(coded).toMatchObject({ state: "code", revision: 1 });
      const verifier = "v".repeat(43);
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const authorize = new URLSearchParams({
        response_type: "code",
        client_id: stagingSynthetic.clientId,
        redirect_uri: TCGPLAYER_CONNECTOR_REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "s".repeat(43),
      });
      const authorized = await send("GET", `/channel-connector/oauth/authorize?${authorize}`);
      expect(new URL(authorized.location!).searchParams.get("code")).toBe(synthetic.code);
      const token = await send(
        "POST",
        "/channel-connector/oauth/token",
        JSON.stringify({
          grant_type: "authorization_code",
          client_id: stagingSynthetic.clientId,
          redirect_uri: TCGPLAYER_CONNECTOR_REDIRECT_URI,
          code: synthetic.code,
          code_verifier: verifier,
        }),
      );
      expect(token.json).toMatchObject({ connection_id: id });
      const claim = () =>
        send("POST", `/channel-connector/oauth/connections/${id}/claim`, "{}", {
          authorization: `Bearer ${synthetic.access}`,
        });
      expect((await claim()).json).toEqual({ reservation: null, pollWindowSeconds: 30 });
      expect((await send("GET", `${api}/connector-pairing`)).json?.state).toBe("paired");
      const unpair = `intent=connector-unpair&pairingId=${coded.pairingId}&revision=1`;
      expect((await send("POST", `/account/channels/${id}`, unpair, form)).status).toBe(303);
      expect(await claim()).toMatchObject({ status: 401, json: { error: "invalid-credential" } });
      expect((await send("POST", `${api}/disconnect`)).json?.status).toBe("disconnected");
      expect(fake.rows().map((row) => `${row.step}:${row.status}`)).toEqual([
        "connect:200",
        "activate:200",
        "pause:200",
        "code:303",
        "pairing-read:200",
        "authorize:302",
        "token:200",
        "claim:200",
        "pairing-read:200",
        "unpair:303",
        "claim:401",
        "disconnect:200",
      ]);
      expect((await send("GET", "/api/channels/connections", undefined, { cookie: "" })).status).toBe(401);
    } finally {
      await fake.close();
    }
  });
});

describe("connector-pairing-drill-deployed composed command before Chromium", () => {
  it("refuses an unavailable sign-in and a provider environment before reading the deploy", async () => {
    const unavailable = await command(pairingArgs(), { signIn: false });
    expect(codeOf(unavailable.error)).toBe("connector-drill-sign-in-unavailable");
    expect(unavailable.resolveDeployBinding).not.toHaveBeenCalled();
    process.env.TCGPLAYER_DRILL_MUTANT = "1";
    try {
      const provider = await command(smokeArgs());
      expect(codeOf(provider.error)).toBe("connector-drill-provider-environment-refused");
      expect(provider.resolveDeployBinding).not.toHaveBeenCalled();
      expect(provider.launches).toEqual([]);
    } finally {
      delete process.env.TCGPLAYER_DRILL_MUTANT;
    }
  });

  it("asks the adapter for the exact required issues and floor, and refuses its stop", async () => {
    const pairing = await command(pairingArgs(), { binding: { stop: "deploy-in-progress" } });
    expect(pairing.resolveDeployBinding).toHaveBeenCalledWith({
      run,
      commit,
      requiredIssues: [10110, 9985, 10639, 10640],
      requireReceiptFloor: true,
    });
    expect(codeOf(pairing.error)).toBe("connector-drill-deploy-binding-refused");
    expect((pairing.error as PairingDrillRefusal).evidence.deployStop).toBe("deploy-in-progress");
    const smoke = await command(smokeArgs(), { binding: { stop: "deploy-run-not-newest" } });
    expect(smoke.resolveDeployBinding).toHaveBeenCalledWith({
      run,
      commit,
      requiredIssues: [10639],
      requireReceiptFloor: false,
    });
    expect(codeOf(smoke.error)).toBe("connector-drill-deploy-binding-refused");
    expect([...pairing.launches, ...smoke.launches]).toEqual([]);
  });

  it("refuses a stale, uncontained or floorless binding before launch", async () => {
    const uncontained = (issue: number) =>
      binding().requiredMerges.map((merge) => (merge.issue === issue ? { ...merge, contained: false } : merge));
    const cases: [string, PairingDrillDeployBinding][] = [
      ["another run", binding({ runId: "2" })],
      ["another deployed head", binding({ deployedHead: "f".repeat(40) })],
      ...[10110, 9985, 10639, 10640].map((issue): [string, PairingDrillDeployBinding] => [
        `#${issue} not contained`,
        binding({ requiredMerges: uncontained(issue) }),
      ]),
      ["#10640 absent", binding({ requiredMerges: binding().requiredMerges.filter((merge) => merge.issue !== 10640) })],
      ["no receipt floor", binding({ receiptFloorRunId: null })],
      ["floor newer than the run", binding({ receiptFloorRunId: "2" })],
    ];
    for (const [name, bound] of cases) {
      const outcome = await command(pairingArgs(), { binding: { binding: bound } });
      expect({ name, code: codeOf(outcome.error), launches: outcome.launches.length }).toEqual({
        name,
        code: "connector-drill-deploy-binding-refused",
        launches: 0,
      });
    }
  });

  it("refuses each failing mount and client row before launch", async () => {
    const json = { "Content-Type": "application/json" };
    const callback = (description: string, host = new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI).host) => ({
      Location: `https://${host}/callback?error=access_denied&error_description=${description}`,
    });
    const cases: [string, Handle, PairingDrillRefusalCode][] = [
      [
        "mount 404",
        authorizeOverride("mount", 404, json, '{"error":"invalid-request"}'),
        "connector-drill-preflight-mount-refused",
      ],
      [
        "mount html",
        authorizeOverride("mount", 400, { "Content-Type": "text/html" }, '{"error":"invalid-request"}'),
        "connector-drill-preflight-mount-refused",
      ],
      [
        "mount other code",
        authorizeOverride("mount", 400, json, '{"error":"other"}'),
        "connector-drill-preflight-mount-refused",
      ],
      ["client 400", authorizeOverride("client", 400, json, "{}"), "connector-drill-preflight-client-refused"],
      [
        "client to another host",
        authorizeOverride("client", 302, callback("authorization_refused", "callback.example")),
        "connector-drill-preflight-client-refused",
      ],
      [
        "client other description",
        authorizeOverride("client", 302, callback("pairing_code_missing")),
        "connector-drill-preflight-client-refused",
      ],
      [
        "unregistered client redirected",
        authorizeOverride("unregistered", 302, callback("authorization_refused")),
        "connector-drill-preflight-client-refused",
      ],
    ];
    for (const [name, handle, code] of cases) {
      const outcome = await command(pairingArgs(), { handle });
      expect({ name, code: codeOf(outcome.error), launches: outcome.launches.length }).toEqual({
        name,
        code,
        launches: 0,
      });
    }
    const untrusted = await command(pairingArgs(), { resolver: "untrusted" });
    expect(codeOf(untrusted.error)).toBe("connector-drill-preflight-mount-refused");
  });

  it("launches only after every row passes, with the exact resolver, one trusted SPKI and a minimal environment", async () => {
    const outcome = await command(pairingArgs());
    expect(outcome.error).toEqual(new Error("launch-refused-by-test"));
    expect(outcome.launches).toHaveLength(1);
    const [{ profilePath, options }] = outcome.launches;
    expect(options.args).toEqual([
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--enable-unsafe-extension-debugging",
      `--host-resolver-rules=MAP ${new URL(staging).hostname}:443 127.0.0.1:${outcome.fake.resolver.port}, MAP * ~NOTFOUND`,
      `--ignore-certificate-errors-spki-list=${outcome.fake.resolver.certificateSpki}`,
    ]);
    expect(options.env).toEqual(drillBrowserEnvironment(process.env));
    // A failed launch still deletes the drill profile.
    expect(existsSync(profilePath)).toBe(false);
    const smoke = await command(smokeArgs());
    expect(smoke.launches[0].options.args).toEqual([
      `--host-resolver-rules=MAP ${new URL(staging).hostname}:443 127.0.0.1:${smoke.fake.resolver.port}, MAP * ~NOTFOUND`,
      `--ignore-certificate-errors-spki-list=${smoke.fake.resolver.certificateSpki}`,
    ]);
    expect(smoke.rows).toEqual([]);
  });
});

describe("connector-pairing-drill-deployed safety and cleanup", () => {
  it("passes Chromium only display, temp and process plumbing, never agent or provider values", () => {
    const environment = drillBrowserEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/drill",
      DISPLAY: ":99",
      XAUTHORITY: "/tmp/xvfb-auth",
      GITHUB_TOKEN: "agent-tier-value",
      BWS_ACCESS_TOKEN: "agent-tier-value",
      TCGPLAYER_SESSION: "provider-value",
      CONNECTOR_CONFIG_ROOT: "/provider",
      OPENAI_API_KEY: "agent-tier-value",
    });
    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/drill",
      DISPLAY: ":99",
      XAUTHORITY: "/tmp/xvfb-auth",
    });
    expect(
      Object.keys(drillBrowserEnvironment(process.env)).filter((key) => providerEnvironmentPattern.test(key)),
    ).toEqual([]);
  });

  it("resolves only the exact staging host on a real run, and loads no extension for smoke", () => {
    expect(deployedBrowserArgs(staging)).toEqual([
      `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(staging).hostname}`,
    ]);
    expect(deployedBrowserArgs(staging, undefined, "/dist")).toEqual([
      "--disable-extensions-except=/dist",
      "--load-extension=/dist",
      "--enable-unsafe-extension-debugging",
      `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(staging).hostname}`,
    ]);
  });

  it("reports the profile deleted only when nothing remains", () => {
    const make = () => {
      const path = mkdtempSync(join(tmpdir(), "connector-drill-unit-profile-"));
      mkdirSync(join(path, "Default"));
      writeFileSync(join(path, "Default", "Cookies"), "profile");
      return path;
    };
    const deleted = make();
    expect(cleanDrillProfile(deleted)).toBe(true);
    expect(existsSync(deleted)).toBe(false);
    const failing = make();
    expect(
      cleanDrillProfile(failing, () => {
        throw new Error("EBUSY");
      }),
    ).toBe(false);
    const ignored = make();
    expect(cleanDrillProfile(ignored, () => undefined)).toBe(false);
    for (const path of [failing, ignored]) rmSync(path, { recursive: true, force: true });
  });

  it("retains a clean receipt alone and deletes one carrying a marker or held literal", () => {
    const directory = mkdtempSync(join(tmpdir(), "connector-drill-unit-retained-"));
    try {
      expect(
        retainDeployedReceipt(directory, { kind: "pairing", lifecycle: ["revoked"] }, [synthetic.cookieValue]),
      ).toBe(1);
      expect(JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"))).toEqual({
        kind: "pairing",
        lifecycle: ["revoked"],
      });
      expect(() => retainDeployedReceipt(directory, { leaked: `Bearer ${synthetic.access}` }, ["Bearer "])).toThrow(
        "connector-retained-artifact-secret",
      );
      expect(existsSync(join(directory, "receipt.json"))).toBe(false);
      expect(() =>
        retainDeployedReceipt(directory, { magic: "held-magic-link-value" }, ["held-magic-link-value"]),
      ).toThrow("connector-retained-artifact-secret");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders a receipt comment only for deployed staging, never for the fake seam", () => {
    const receipt = { origin: "fake", kind: "staging-smoke" } as DeployedPairingDrillReceipt;
    expect(() => stagingReceiptComment(receipt)).toThrow("connector-drill-fake-receipt-refused");
    expect(stagingReceiptComment({ ...receipt, origin: "staging" })).toContain("### staging-smoke receipt");
  });
});
