import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => []);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const recorded = ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"];
  return {
    ...actual,
    ...Object.fromEntries(
      recorded.map((name) => [
        name,
        (...args) => {
          spawned.push(name);
          return actual[name](...args);
        },
      ]),
    ),
  };
});

import {
  checkCredentialLiveness,
  classifyCredentialHealth,
  collectSecretMetadata,
  credentialHealthAlert,
  main,
  parseGitHubTokenExpiration,
  renderCredentialHealthSummary,
  runLivenessRow,
  signAwsV4Request,
} from "./credential-health.mjs";
import {
  CREDENTIAL_INVENTORY_PATH,
  SPACES_LIVENESS_KINDS,
  validateCredentialInventory,
} from "./credential-inventory.mjs";
import { SUBCOMMANDS } from "./ops.mjs";
import { releaseQualificationScopeRegistry } from "./release-qualification-scope.mjs";

const DAY = 86_400_000;
const NOW = new Date("2026-10-17T12:00:00Z");
const SENTINEL = "SENTINEL_SECRET_VALUE_9912";
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY).toISOString();

function inventoryOf(secrets) {
  const { errors, inventory } = validateCredentialInventory({
    schemaVersion: 1,
    environments: ["production", "staging"],
    secrets,
  });
  expect(errors).toEqual([]);
  return inventory;
}

function entry(name, overrides = {}) {
  return {
    name,
    scope: ["staging"],
    kind: "credential",
    rotation: "assisted",
    providerExpiryDays: null,
    maxAgeDays: 365,
    liveness: null,
    pairedWith: [],
    proofWorkflows: [],
    ...overrides,
  };
}

function metadataOf(scopes, { failed = [] } = {}) {
  const all = { repository: [], production: [], staging: [], ...scopes };
  return {
    schemaVersion: "credential-metadata/v1",
    collectedAt: NOW.toISOString(),
    environments: { status: "collected", names: ["production", "staging"] },
    scopes: Object.fromEntries(
      Object.entries(all).map(([scope, secrets]) => [
        scope,
        failed.includes(scope)
          ? { status: "failed", reason: "http-403" }
          : { status: "collected", secrets: secrets.map(([name, updatedAt]) => ({ name, updatedAt })) },
      ]),
    ),
  };
}

function livenessOf(rows = {}) {
  return Object.fromEntries(
    ["repository", "production", "staging"].map((scope) => [
      scope,
      { schemaVersion: "credential-liveness/v1", scope, checkedAt: NOW.toISOString(), results: rows[scope] ?? [] },
    ]),
  );
}

function classify(
  inventory,
  metadata,
  liveness = livenessOf(),
  jobResults = { metadata: "success", liveness: "success" },
) {
  return classifyCredentialHealth({ inventory, metadata, liveness, jobResults, now: NOW });
}

const doToken = entry("DIGITALOCEAN_ACCESS_TOKEN", {
  providerExpiryDays: 90,
  liveness: { kind: "digitalocean-account" },
});
const liveDo = { staging: [{ name: "DIGITALOCEAN_ACCESS_TOKEN", kind: "digitalocean-account", verdict: "live" }] };

describe("credential health classifier (AC2)", () => {
  it.each([
    [85, "failure", ["provider-expiry-within-7-days"]],
    [75, "warning", ["provider-expiry-within-21-days"]],
    [30, "success", []],
  ])("an assisted DigitalOcean token at %i days is %s", (age, level, reasons) => {
    const report = classify(
      inventoryOf([doToken]),
      metadataOf({ staging: [["DIGITALOCEAN_ACCESS_TOKEN", daysAgo(age)]] }),
      livenessOf(liveDo),
    );
    expect(report.groups[0]).toMatchObject({ level, reasons, ageDays: age });
    expect(report.status).toBe(level);
  });

  it.each([
    [13, "success", []],
    [22, "warning", ["older-than-max-age-plus-7"]],
    [23, "failure", ["older-than-max-age-plus-7", "provider-expiry-within-7-days"]],
  ])("an automatic entry (max 14, provider 30) at %i days is %s", (age, level, reasons) => {
    const automatic = entry("ROTATED_KEY", { rotation: "automatic", maxAgeDays: 14, providerExpiryDays: 30 });
    const report = classify(inventoryOf([automatic]), metadataOf({ staging: [["ROTATED_KEY", daysAgo(age)]] }));
    expect(report.groups[0]).toMatchObject({ level, reasons });
  });

  it("fails on age past maxAgeDays and warns within 30 days of it for assisted and external-owner entries", () => {
    const inventory = inventoryOf([entry("COOKIE", { rotation: "external-owner", owner: 8447 }), entry("OLD_KEY")]);
    const report = classify(
      inventory,
      metadataOf({
        staging: [
          ["COOKIE", daysAgo(340)],
          ["OLD_KEY", daysAgo(366)],
        ],
      }),
    );
    expect(report.groups.map(({ name, level, reasons }) => [name, level, reasons])).toEqual([
      ["COOKIE", "warning", ["max-age-within-30-days"]],
      ["OLD_KEY", "failure", ["older-than-max-age"]],
    ]);
  });

  it.each([
    ["dead", "failure", ["liveness-dead"]],
    ["unknown", "warning", ["liveness-unknown"]],
    ["absent", "warning", ["liveness-not-collected"]],
  ])("liveness %s is %s", (verdict, level, reasons) => {
    const report = classify(
      inventoryOf([doToken]),
      metadataOf({ staging: [["DIGITALOCEAN_ACCESS_TOKEN", daysAgo(5)]] }),
      livenessOf({ staging: [{ name: "DIGITALOCEAN_ACCESS_TOKEN", kind: "digitalocean-account", verdict }] }),
    );
    expect(report.groups[0]).toMatchObject({ level, reasons });
  });

  it("classifies a real 403 liveness response as warning, not dead", async () => {
    const result = await checkCredentialLiveness(
      "digitalocean-account",
      { token: "do-forbidden" },
      { fetch: async () => new Response("", { status: 403 }) },
    );
    expect(result).toEqual({ verdict: "unknown", reason: "http-403" });
    const report = classify(
      inventoryOf([doToken]),
      metadataOf({ staging: [["DIGITALOCEAN_ACCESS_TOKEN", daysAgo(5)]] }),
      livenessOf({ staging: [{ name: "DIGITALOCEAN_ACCESS_TOKEN", kind: "digitalocean-account", ...result }] }),
    );
    expect(report.status).toBe("warning");
  });

  it("warns on a collection error and never reports success", () => {
    const inventory = inventoryOf([entry("STRIPE_KEY")]);
    const control = classify(inventory, metadataOf({ staging: [["STRIPE_KEY", daysAgo(5)]] }));
    expect(control.status).toBe("success");
    const report = classify(inventory, metadataOf({ staging: [["STRIPE_KEY", daysAgo(5)]] }, { failed: ["staging"] }));
    expect(report.status).toBe("warning");
    expect(report.groups[0]).toMatchObject({ level: "warning", reasons: ["metadata-not-collected"] });
    expect(report.findings).toContainEqual({
      part: "metadata",
      scope: "staging",
      level: "warning",
      reason: "metadata-not-collected",
    });
  });

  it("does not warn for an unset optional name but does for a missing required one", () => {
    const inventory = inventoryOf([entry("REQUIRED_KEY"), entry("UNSET_SIGNING_KEY", { optional: true })]);
    const report = classify(inventory, metadataOf({}));
    expect(report.groups.map(({ name, level, reasons }) => [name, level, reasons])).toEqual([
      ["REQUIRED_KEY", "warning", ["missing-from-scope"]],
      ["UNSET_SIGNING_KEY", "success", []],
    ]);
  });

  it("warns on a live name that is not in the inventory for that scope", () => {
    const inventory = inventoryOf([entry("STRIPE_KEY")]);
    const report = classify(
      inventory,
      metadataOf({ staging: [["STRIPE_KEY", daysAgo(5)]], production: [["STRIPE_KEY", daysAgo(5)]] }),
    );
    expect(report.status).toBe("warning");
    expect(report.table).toContainEqual(
      expect.objectContaining({
        scope: "production",
        name: "STRIPE_KEY",
        inventory: "not inventoried",
        level: "warning",
      }),
    );
  });

  it("ages a two-environment value group from its older write", () => {
    const shared = entry("SHARED_TOKEN", {
      scope: ["production", "staging"],
      valueGroups: [["production", "staging"]],
      providerExpiryDays: 90,
    });
    const report = classify(
      inventoryOf([shared]),
      metadataOf({ production: [["SHARED_TOKEN", daysAgo(10)]], staging: [["SHARED_TOKEN", daysAgo(13)]] }),
    );
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({
      ageDays: 13,
      updatedAt: daysAgo(13).slice(0, 10),
      providerExpiresAt: new Date(NOW.getTime() + 77 * DAY).toISOString().slice(0, 10),
    });
  });

  describe("GitHub token expiry headers", () => {
    const githubToken = entry("PROJECTS_TOKEN", { scope: "repository", liveness: { kind: "github-token" } });
    const responseDate = NOW.toUTCString();
    async function check(header) {
      const headers = { date: responseDate };
      if (header !== undefined) headers["github-authentication-token-expiration"] = header;
      return checkCredentialLiveness(
        "github-token",
        { token: "ghp-live" },
        { fetch: async () => new Response("{}", { status: 200, headers }) },
      );
    }
    async function level(header) {
      const result = await check(header);
      const report = classify(
        inventoryOf([githubToken]),
        metadataOf({ repository: [["PROJECTS_TOKEN", daysAgo(30)]] }),
        livenessOf({ repository: [{ name: "PROJECTS_TOKEN", kind: "github-token", ...result }] }),
      );
      return { result, group: report.groups[0] };
    }

    it("fails five days before the measured expiry", async () => {
      const { result, group } = await level("2026-10-22 12:00:00 UTC");
      expect(result).toMatchObject({ verdict: "live", providerExpiresAt: "2026-10-22T12:00:00.000Z" });
      expect(group).toMatchObject({ level: "failure", reasons: ["provider-expiry-within-7-days"] });
    });

    it("applies a +0100 offset", async () => {
      expect(parseGitHubTokenExpiration("2027-01-01 01:00:00 +0100")).toBe(Date.parse("2027-01-01T00:00:00Z"));
      const { result, group } = await level("2027-01-01 01:00:00 +0100");
      expect(result.providerExpiresAt).toBe("2027-01-01T00:00:00.000Z");
      expect(group).toMatchObject({ level: "success", providerExpiresAt: "2027-01-01" });
    });

    it("treats an absent header as no expiry", async () => {
      const { result, group } = await level(undefined);
      expect(result).toMatchObject({ verdict: "live", expiryMeasured: true, providerExpiresAt: null });
      expect(group).toMatchObject({ level: "success", providerExpiresAt: null });
    });

    it.each([
      ["malformed", "2026-12-01T00:00:00Z", "expiry-header-malformed"],
      ["an impossible date", "2026-02-30 00:00:00 UTC", "expiry-header-malformed"],
      ["equal to Date", "2026-10-17 12:00:00 UTC", "expiry-not-after-response-date"],
    ])("treats %s as unknown", async (_label, header, reason) => {
      const { result, group } = await level(header);
      expect(result).toEqual({ verdict: "unknown", reason });
      expect(group).toMatchObject({ level: "warning", reasons: ["liveness-unknown"] });
    });
  });
});

describe("agent token accounts (#10034)", () => {
  const daysAhead = (days, from = NOW) => new Date(from.getTime() + days * DAY).toISOString().slice(0, 10);
  const healthyKey = entry("STRIPE_KEY");
  const healthyMetadata = metadataOf({ staging: [["STRIPE_KEY", daysAgo(5)]] });

  function inventoryWithAccounts(accounts, secrets = [healthyKey]) {
    const { errors, inventory } = validateCredentialInventory({
      schemaVersion: 1,
      environments: ["production", "staging"],
      secrets,
      agentTier: { project: "chase-sets-agent-dev", keys: [], accounts },
    });
    expect(errors).toEqual([]);
    return inventory;
  }
  const lanes = (tokenExpiresOn) => ({
    name: "lanes",
    machineAccount: "chase-sets-lanes",
    access: "read",
    tokenExpiresOn,
  });

  it.each([
    [30, "success"],
    [22, "success"],
    [21, "warning"],
    [20, "warning"],
    [8, "warning"],
    [7, "failure"],
    [6, "failure"],
    [0, "failure"],
    [-1, "failure"],
  ])("classifies a token %i days from expiry as %s with the assisted D2 levels (AC1)", (days, level) => {
    const report = classify(inventoryWithAccounts([lanes(daysAhead(days))]), healthyMetadata);
    expect(report.accounts).toEqual([{ name: "lanes", tokenExpiresOn: daysAhead(days), daysRemaining: days, level }]);
    expect(report.status).toBe(level);
  });

  it("shows a null tokenExpiresOn as not issued at success, with no warning or failure (AC1)", () => {
    const report = classify(inventoryWithAccounts([lanes(null)]), healthyMetadata);
    expect(report.accounts).toEqual([{ name: "lanes", tokenExpiresOn: null, daysRemaining: null, level: "success" }]);
    expect(report.status).toBe("success");
    expect(renderCredentialHealthSummary(report)).toContain("| lanes | not issued | — | success |");
    const alert = credentialHealthAlert(report);
    expect(alert.status).toBe("success");
    expect(alert.details).toBe("- success: agent token lanes not issued");
  });

  it("counts whole UTC calendar days, so the start and end of a UTC day agree", () => {
    const inventory = inventoryWithAccounts([lanes("2026-10-24")]);
    const at = (iso) =>
      classifyCredentialHealth({
        inventory,
        metadata: healthyMetadata,
        liveness: livenessOf(),
        jobResults: { metadata: "success", liveness: "success" },
        now: new Date(iso),
      }).accounts[0];
    expect(at("2026-10-17T00:00:00.000Z")).toMatchObject({ daysRemaining: 7, level: "failure" });
    expect(at("2026-10-17T23:59:59.999Z")).toMatchObject({ daysRemaining: 7, level: "failure" });
    expect(at("2026-10-16T23:59:59.999Z")).toMatchObject({ daysRemaining: 8, level: "warning" });
    expect(at("2026-10-24T23:59:59.999Z")).toMatchObject({ daysRemaining: 0, level: "failure" });
  });

  it("puts only the name, date, days and level in the summary and the alert (AC2)", () => {
    const inventory = inventoryWithAccounts([lanes(daysAhead(20))]);
    const report = classify(inventory, healthyMetadata);
    expect(Object.keys(report.accounts[0]).sort()).toEqual(["daysRemaining", "level", "name", "tokenExpiresOn"]);
    const summary = renderCredentialHealthSummary(report);
    expect(summary).toContain(
      [
        "### Agent token accounts",
        "",
        "| Account | Token expires | Days remaining | Level |",
        "| --- | --- | --- | --- |",
        `| lanes | ${daysAhead(20)} | 20 | warning |`,
      ].join("\n"),
    );
    expect(summary).toContain("- Agent token accounts: 0 failure, 1 warning, 0 success");
    const alert = credentialHealthAlert(report);
    expect(alert).toEqual({
      status: "warning",
      summary:
        "Credential health warning: 0 failure and 0 warning value groups; 0 failure and 1 warning agent token accounts; 0 collection findings.",
      details: `- warning: agent token lanes expires ${daysAhead(20)} (20 days)`,
    });
  });

  it("lists account rows after collection findings and before value groups, so truncation keeps them", () => {
    const inventory = inventoryWithAccounts([lanes(daysAhead(3))]);
    const report = classify(inventory, metadataOf({}, { failed: ["staging"] }));
    const lines = credentialHealthAlert(report, { maxLines: 2 }).details.split("\n");
    expect(lines[0]).toBe("- warning: metadata (staging) metadata-not-collected");
    expect(lines[1]).toBe(`- failure: agent token lanes expires ${daysAhead(3)} (3 days)`);
    expect(lines.at(-1)).toMatch(/^- … \d+ more in the run summary$/);
  });

  it("still warns, never success, when collection fails beside a healthy account", () => {
    const report = classify(inventoryWithAccounts([lanes(daysAhead(60))]), null);
    expect(report.accounts[0].level).toBe("success");
    expect(report.status).toBe("warning");
  });

  it("attempts no metadata or liveness collection for an account", async () => {
    const withLiveness = inventoryWithAccounts([lanes(daysAhead(60))], [doToken]);
    const read = [];
    const env = new Proxy(
      {},
      {
        get(_target, name) {
          read.push(name);
          return undefined;
        },
      },
    );
    for (const scope of withLiveness.scopes) {
      const row = await runLivenessRow({ inventory: withLiveness, scope, env, now: NOW });
      expect(row.results.map((result) => result.name)).toEqual(scope === "staging" ? ["DIGITALOCEAN_ACCESS_TOKEN"] : []);
    }
    // The empty token is "absent" before any request, and no account name is read.
    expect(read).toEqual(["DIGITALOCEAN_ACCESS_TOKEN"]);
    const report = classify(inventoryWithAccounts([lanes(daysAhead(60))]), healthyMetadata);
    expect(report.groups.map((group) => group.name)).toEqual(["STRIPE_KEY"]);
    expect(report.table.map((row) => row.name)).not.toContain("lanes");
    expect(report.findings).toEqual([]);
  });

  it("reports the repository's lanes account with the expiry #10032 recorded", () => {
    const report = classify(repositoryInventory, null);
    expect(report.accounts).toEqual([
      { name: "lanes", tokenExpiresOn: "2027-01-16", daysRemaining: 91, level: "success" },
    ]);
  });
});

// One fake provider for every liveness kind. Each response body echoes the
// request's credentials so a leak of response text would carry the sentinel.
let server;
let endpoint;
const requests = [];
beforeAll(async () => {
  server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    requests.push({ url: request.url, headers: request.headers });
    const echo = `${SENTINEL} ${authorization}`;
    if (request.url === "/v2/account") {
      const status = { [`Bearer do-live-${SENTINEL}`]: 200, [`Bearer do-dead-${SENTINEL}`]: 401 }[authorization] ?? 403;
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ message: echo }));
      return;
    }
    if (request.url === "/user") {
      const live = authorization === `Bearer gh-live-${SENTINEL}`;
      response
        .writeHead(live ? 200 : 401, {
          "content-type": "application/json",
          ...(live ? { "github-authentication-token-expiration": "2099-12-31 00:00:00 UTC" } : {}),
        })
        .end(JSON.stringify({ message: echo }));
      return;
    }
    const credential = authorization.indexOf("Credential=");
    const keyStart = credential + "Credential=".length;
    const keyEnd = credential === -1 ? -1 : authorization.indexOf("/", keyStart);
    const accessKeyId = keyEnd > keyStart ? authorization.slice(keyStart, keyEnd) : "";
    const code = {
      [`spaces-dead-${SENTINEL}`]: "InvalidAccessKeyId",
      [`spaces-signature-${SENTINEL}`]: "SignatureDoesNotMatch",
      [`spaces-denied-${SENTINEL}`]: "AccessDenied",
      [`spaces-teapot-${SENTINEL}`]: "Teapot",
    }[accessKeyId];
    if (!code) {
      response
        .writeHead(200, { "content-type": "application/xml" })
        .end(`<ListBucketResult>${echo}</ListBucketResult>`);
      return;
    }
    response
      .writeHead(code === "Teapot" ? 418 : 403, { "content-type": "application/xml" })
      .end(`<Error><Code>${code}</Code><Message>${echo}</Message></Error>`);
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolveClose) => server.close(resolveClose)));

const endpoints = () => ({ digitalocean: endpoint, spaces: endpoint, github: endpoint });

describe("checkCredentialLiveness (AC3)", () => {
  it("reproduces AWS's published SigV4 example signatures", () => {
    const base = {
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
    };
    expect(
      signAwsV4Request({
        ...base,
        url: "https://examplebucket.s3.amazonaws.com/test.txt",
        headers: { range: "bytes=0-9" },
      }).signature,
    ).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(
      signAwsV4Request({ ...base, url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J" }).signature,
    ).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    expect(signAwsV4Request({ ...base, url: "https://examplebucket.s3.amazonaws.com/?lifecycle" }).signature).toBe(
      "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    );
  });

  it.each([
    ["digitalocean-account", { token: `do-live-${SENTINEL}` }, { verdict: "live", reason: "http-200" }],
    ["digitalocean-account", { token: `do-dead-${SENTINEL}` }, { verdict: "dead", reason: "http-401" }],
    ["digitalocean-account", { token: `do-other-${SENTINEL}` }, { verdict: "unknown", reason: "http-403" }],
    ["digitalocean-account", { token: "" }, { verdict: "absent", reason: "no-value" }],
    [
      "github-token",
      { token: `gh-live-${SENTINEL}` },
      { verdict: "live", reason: "http-200", expiryMeasured: true, providerExpiresAt: "2099-12-31T00:00:00.000Z" },
    ],
    ["github-token", { token: `gh-dead-${SENTINEL}` }, { verdict: "dead", reason: "http-401" }],
    [
      "spaces-list-buckets",
      { accessKeyId: `spaces-live-${SENTINEL}`, secretAccessKey: SENTINEL },
      { verdict: "live", reason: "http-200" },
    ],
    [
      "spaces-list-buckets",
      { accessKeyId: `spaces-dead-${SENTINEL}`, secretAccessKey: SENTINEL },
      { verdict: "dead", reason: "invalid-access-key-id" },
    ],
    [
      "spaces-bucket",
      { accessKeyId: `spaces-signature-${SENTINEL}`, secretAccessKey: SENTINEL, bucket: "evidence-bucket" },
      { verdict: "unknown", reason: "signature-does-not-match" },
    ],
    [
      "spaces-bucket",
      { accessKeyId: `spaces-denied-${SENTINEL}`, secretAccessKey: SENTINEL, bucket: "evidence-bucket" },
      { verdict: "unknown", reason: "access-denied" },
    ],
    [
      "spaces-bucket",
      { accessKeyId: `spaces-teapot-${SENTINEL}`, secretAccessKey: SENTINEL, bucket: "evidence-bucket" },
      { verdict: "unknown", reason: "http-4xx" },
    ],
    [
      "spaces-bucket",
      { accessKeyId: "", secretAccessKey: SENTINEL, bucket: "evidence-bucket" },
      { verdict: "absent", reason: "no-value" },
    ],
  ])("%s against the fake provider -> %o", async (kind, credentials, expected) => {
    const result = await checkCredentialLiveness(kind, credentials, { endpoints: endpoints(), now: NOW });
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("classifies network errors and 5xx as unknown, never dead", async () => {
    const closed = { digitalocean: "http://127.0.0.1:9", spaces: "http://127.0.0.1:9", github: "http://127.0.0.1:9" };
    for (const kind of ["digitalocean-account", "github-token", "spaces-list-buckets"]) {
      expect(
        await checkCredentialLiveness(
          kind,
          { token: "t", accessKeyId: "a", secretAccessKey: "s" },
          { endpoints: closed },
        ),
      ).toEqual({ verdict: "unknown", reason: "network-error" });
    }
    const unavailable = async () => new Response("", { status: 503 });
    expect(await checkCredentialLiveness("digitalocean-account", { token: "t" }, { fetch: unavailable })).toEqual({
      verdict: "unknown",
      reason: "http-5xx",
    });
    expect(
      await checkCredentialLiveness(
        "spaces-list-buckets",
        { accessKeyId: "a", secretAccessKey: "s" },
        { fetch: unavailable },
      ),
    ).toEqual({ verdict: "unknown", reason: "http-5xx" });
  });

  it("signs path-style Spaces requests for nyc3 with the empty-body hash and asks a scoped pair only for its bucket", async () => {
    const inventory = inventoryOf([
      entry("EVIDENCE_SPACES_ACCESS_ID", {
        liveness: { kind: "spaces-bucket", bucket: "evidence-bucket" },
        pairedWith: ["EVIDENCE_SPACES_SECRET_KEY"],
      }),
      entry("EVIDENCE_SPACES_SECRET_KEY", { pairedWith: ["EVIDENCE_SPACES_ACCESS_ID"] }),
    ]);
    requests.length = 0;
    const row = await runLivenessRow({
      inventory,
      scope: "staging",
      env: { EVIDENCE_SPACES_ACCESS_ID: `spaces-live-${SENTINEL}`, EVIDENCE_SPACES_SECRET_KEY: SENTINEL },
      endpoints: endpoints(),
      now: NOW,
    });
    expect(row.results).toEqual([
      { name: "EVIDENCE_SPACES_ACCESS_ID", kind: "spaces-bucket", verdict: "live", reason: "http-200" },
    ]);
    expect(requests.map(({ url }) => url)).toEqual(["/evidence-bucket?list-type=2&max-keys=0"]);
    const [{ headers }] = requests;
    expect(headers["x-amz-content-sha256"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=spaces-live-[^/]+\/20261017\/nyc3\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it("reads only the secrets whose inventory scope includes the row", async () => {
    const inventory = inventoryOf([
      { ...doToken, scope: ["production"] },
      entry("PROJECTS_TOKEN", { scope: "repository", liveness: { kind: "github-token" } }),
    ]);
    const read = [];
    const env = new Proxy(
      { DIGITALOCEAN_ACCESS_TOKEN: `do-live-${SENTINEL}`, PROJECTS_TOKEN: `gh-live-${SENTINEL}` },
      {
        get(target, name) {
          read.push(name);
          return target[name];
        },
      },
    );
    const row = await runLivenessRow({ inventory, scope: "production", env, endpoints: endpoints(), now: NOW });
    expect(read).toEqual(["DIGITALOCEAN_ACCESS_TOKEN"]);
    expect(row.results.map(({ name }) => name)).toEqual(["DIGITALOCEAN_ACCESS_TOKEN"]);
  });

  it("runs every kind and the report without spawning a process", async () => {
    spawned.length = 0;
    const kinds = [
      ["digitalocean-account", { token: `do-live-${SENTINEL}` }],
      ["github-token", { token: `gh-live-${SENTINEL}` }],
      ["spaces-list-buckets", { accessKeyId: `spaces-live-${SENTINEL}`, secretAccessKey: SENTINEL }],
      [
        "spaces-bucket",
        { accessKeyId: `spaces-live-${SENTINEL}`, secretAccessKey: SENTINEL, bucket: "evidence-bucket" },
      ],
    ];
    for (const [kind, credentials] of kinds) {
      expect((await checkCredentialLiveness(kind, credentials, { endpoints: endpoints(), now: NOW })).verdict).toBe(
        "live",
      );
    }
    const inventory = inventoryOf([doToken]);
    const row = await runLivenessRow({
      inventory,
      scope: "staging",
      env: { DIGITALOCEAN_ACCESS_TOKEN: `do-live-${SENTINEL}` },
      endpoints: endpoints(),
      now: NOW,
    });
    renderCredentialHealthSummary(
      classify(inventory, metadataOf({ staging: [["DIGITALOCEAN_ACCESS_TOKEN", daysAgo(1)]] }), {
        ...livenessOf(),
        staging: row,
      }),
    );
    expect(spawned).toEqual([]);
    for (const file of ["scripts/credential-health.mjs", "scripts/credential-inventory.mjs"]) {
      expect(readFileSync(resolve(file), "utf8")).not.toMatch(/child_process/);
    }
  });
});

describe("credential health report outputs (AC3)", () => {
  const secrets = [
    { ...doToken, scope: ["production", "staging"] },
    entry("PROJECTS_TOKEN", { scope: "repository", liveness: { kind: "github-token" } }),
    entry("SPACES_ACCESS_ID", { liveness: { kind: "spaces-list-buckets" }, pairedWith: ["SPACES_SECRET_KEY"] }),
    entry("SPACES_SECRET_KEY", { pairedWith: ["SPACES_ACCESS_ID"] }),
  ];
  const inventory = inventoryOf(secrets);

  // A throwaway repository root holding this fixture's inventory for the CLI.
  function repositoryRoot(directory) {
    const root = join(directory, "repository");
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(
      join(root, CREDENTIAL_INVENTORY_PATH),
      JSON.stringify({ schemaVersion: 1, environments: ["production", "staging"], secrets }),
    );
    return root;
  }
  const metadata = metadataOf({
    repository: [["PROJECTS_TOKEN", daysAgo(30)]],
    production: [["DIGITALOCEAN_ACCESS_TOKEN", daysAgo(5)]],
    staging: [
      ["DIGITALOCEAN_ACCESS_TOKEN", daysAgo(5)],
      ["SPACES_ACCESS_ID", daysAgo(5)],
      ["SPACES_SECRET_KEY", daysAgo(5)],
    ],
  });
  const env = {
    staging: {
      DIGITALOCEAN_ACCESS_TOKEN: `do-dead-${SENTINEL}`,
      SPACES_ACCESS_ID: `spaces-dead-${SENTINEL}`,
      SPACES_SECRET_KEY: SENTINEL,
    },
    production: { DIGITALOCEAN_ACCESS_TOKEN: `do-other-${SENTINEL}` },
    repository: { PROJECTS_TOKEN: `gh-live-${SENTINEL}` },
  };

  async function liveRows(overrides = env) {
    const rows = {};
    for (const scope of inventory.scopes) {
      rows[scope] = await runLivenessRow({
        inventory,
        scope,
        env: overrides[scope] ?? {},
        endpoints: endpoints(),
        now: NOW,
      });
    }
    return rows;
  }

  it("keeps a sentinel secret out of liveness rows, the report, the summary, the alert and the step outputs", async () => {
    const liveness = await liveRows();
    const report = classifyCredentialHealth({ inventory, metadata, liveness, now: NOW });
    expect(report.status).toBe("failure");
    const summary = renderCredentialHealthSummary(report);
    const alert = credentialHealthAlert(report);
    expect(summary).toContain("| DIGITALOCEAN_ACCESS_TOKEN | credential, assisted |");
    expect(alert.details).toContain("failure: DIGITALOCEAN_ACCESS_TOKEN (staging) liveness-dead");
    for (const output of [liveness, report, summary, alert]) {
      expect(JSON.stringify(output)).not.toContain(SENTINEL);
    }
  });

  it("writes the report, summary and step outputs from the CLI without the sentinel", async () => {
    const directory = mkdtempSync(join(tmpdir(), "credential-health-"));
    try {
      const liveness = await liveRows();
      for (const [scope, row] of Object.entries(liveness)) {
        writeFileSync(join(directory, `liveness-${scope}.json`), JSON.stringify(row));
      }
      writeFileSync(join(directory, "metadata.json"), JSON.stringify(metadata));
      const summary = join(directory, "summary.md");
      const output = join(directory, "output.txt");
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await main(
          [
            "report",
            "--repository-root",
            repositoryRoot(directory),
            "--metadata",
            join(directory, "metadata.json"),
            "--liveness-dir",
            directory,
            "--metadata-result",
            "success",
            "--liveness-result",
            "success",
            "--out",
            join(directory, "report.json"),
            "--summary",
            summary,
            "--github-output",
            output,
          ],
          {},
        );
      } finally {
        write.mockRestore();
      }
      const outputs = readFileSync(output, "utf8");
      expect(outputs).toMatch(/^status=failure\nsummary=Credential health failure: /);
      expect(outputs).toMatch(/\ndetails<<CREDENTIAL_HEALTH_[0-9a-f]{32}\n[\s\S]*\nCREDENTIAL_HEALTH_[0-9a-f]{32}\n$/);
      for (const file of ["report.json", "summary.md", "output.txt"]) {
        expect(readFileSync(join(directory, file), "utf8")).not.toContain(SENTINEL);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe("a failed or absent metadata or liveness result is warning, never success", () => {
    const healthy = {
      staging: {
        DIGITALOCEAN_ACCESS_TOKEN: `do-live-${SENTINEL}`,
        SPACES_ACCESS_ID: `spaces-live-${SENTINEL}`,
        SPACES_SECRET_KEY: SENTINEL,
      },
      production: { DIGITALOCEAN_ACCESS_TOKEN: `do-live-${SENTINEL}` },
      repository: { PROJECTS_TOKEN: `gh-live-${SENTINEL}` },
    };
    const ok = { metadata: "success", liveness: "success" };

    it("is success only with every input collected", async () => {
      const report = classifyCredentialHealth({
        inventory,
        metadata,
        liveness: await liveRows(healthy),
        jobResults: ok,
        now: NOW,
      });
      expect(report.status).toBe("success");
    });

    it.each([
      ["absent metadata", { metadata: null }],
      ["failed metadata scope", { metadata: metadataOf({}, { failed: ["staging"] }) }],
      [
        "undiscovered environments",
        { metadata: { ...metadata, environments: { status: "failed", reason: "http-403" } } },
      ],
      ["failed metadata job", { jobResults: { ...ok, metadata: "failure" } }],
      ["skipped metadata job", { jobResults: { ...ok, metadata: "skipped" } }],
      ["failed liveness job", { jobResults: { ...ok, liveness: "failure" } }],
      ["cancelled liveness job", { jobResults: { ...ok, liveness: "cancelled" } }],
      ["absent liveness row", { dropRow: "staging" }],
      ["a liveness row for another scope", { swapRow: "production" }],
    ])("%s", async (_label, change) => {
      const liveness = await liveRows(healthy);
      if (change.dropRow) delete liveness[change.dropRow];
      if (change.swapRow) liveness[change.swapRow] = { ...liveness.staging };
      const report = classifyCredentialHealth({
        inventory,
        metadata: "metadata" in change ? change.metadata : metadata,
        liveness,
        jobResults: change.jobResults ?? ok,
        now: NOW,
      });
      expect(report.status).toBe("warning");
    });

    it("reports warning from the CLI when the metadata file is missing", async () => {
      const directory = mkdtempSync(join(tmpdir(), "credential-health-"));
      try {
        const output = join(directory, "output.txt");
        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
          await main(
            [
              "report",
              "--repository-root",
              repositoryRoot(directory),
              "--metadata",
              join(directory, "missing.json"),
              "--liveness-dir",
              directory,
              "--metadata-result",
              "failure",
              "--liveness-result",
              "success",
              "--out",
              join(directory, "report.json"),
              "--github-output",
              output,
            ],
            {},
          );
        } finally {
          write.mockRestore();
        }
        expect(readFileSync(output, "utf8")).toMatch(/^status=warning\n/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});

describe("collectSecretMetadata", () => {
  const inventory = inventoryOf([entry("STRIPE_KEY", { scope: ["production", "staging"] })]);
  const page = (size, offset = 0) =>
    Array.from({ length: size }, (_, index) => ({
      name: `SECRET_${String(offset + index).padStart(3, "0")}`,
      created_at: daysAgo(40),
      updated_at: daysAgo(4),
    }));

  // A fake GitHub API: `routes` maps a path to its pages, or to a status.
  function githubApi(routes) {
    const calls = [];
    const fetch = async (url, init) => {
      const { pathname, searchParams } = new URL(url);
      calls.push({ path: pathname, page: Number(searchParams.get("page")), auth: init.headers.authorization });
      const route = routes[pathname];
      if (typeof route === "number") return new Response(JSON.stringify({ message: SENTINEL }), { status: route });
      const { total, pages, key = "secrets" } = route;
      const items = pages[Number(searchParams.get("page")) - 1] ?? [];
      return Response.json({ total_count: total, [key]: items });
    };
    return { calls, fetch };
  }
  const base = "/repos/chase-sets/chase-sets";
  const environments = (names) => ({
    total: names.length,
    key: "environments",
    pages: [names.map((name) => ({ name }))],
  });

  it("pages until total_count, lists discovered environments, and feeds the classifier", async () => {
    const api = githubApi({
      [`${base}/environments`]: environments(["production", "staging", "sandbox"]),
      [`${base}/actions/secrets`]: { total: 0, pages: [[]] },
      [`${base}/environments/production/secrets`]: {
        total: 1,
        pages: [[{ name: "STRIPE_KEY", updated_at: daysAgo(4) }]],
      },
      [`${base}/environments/staging/secrets`]: {
        total: 150,
        pages: [[...page(99), { name: "STRIPE_KEY", updated_at: daysAgo(9) }], page(50, 99)],
      },
      [`${base}/environments/sandbox/secrets`]: { total: 1, pages: [[{ name: "STRIPE_KEY", updated_at: daysAgo(1) }]] },
    });
    const metadata = await collectSecretMetadata({
      inventory,
      repository: "chase-sets/chase-sets",
      token: `app-${SENTINEL}`,
      fetch: api.fetch,
    });
    expect(metadata.environments).toEqual({ status: "collected", names: ["production", "sandbox", "staging"] });
    expect(metadata.scopes.staging.status).toBe("collected");
    expect(metadata.scopes.staging.secrets).toHaveLength(150);
    expect(api.calls.filter(({ path }) => path.endsWith("/staging/secrets")).map(({ page: number }) => number)).toEqual(
      [1, 2],
    );
    expect(JSON.stringify(metadata)).not.toContain(SENTINEL);

    const report = classify(inventory, metadata, livenessOf());
    expect(report.groups.find(({ name, scopes }) => name === "STRIPE_KEY" && scopes[0] === "staging")).toMatchObject({
      ageDays: 9,
      level: "success",
    });
    expect(report.table).toContainEqual(
      expect.objectContaining({ scope: "staging", name: "SECRET_000", inventory: "not inventoried", level: "warning" }),
    );
    expect(report.table).toContainEqual(
      expect.objectContaining({ scope: "sandbox", name: "STRIPE_KEY", inventory: "not inventoried" }),
    );
  });

  it.each([
    ["a short last page", { total: 150, pages: [page(100)] }, "pagination-mismatch"],
    ["a total that changes between pages", null, "pagination-mismatch"],
    ["duplicate names across pages", { total: 2, pages: [[page(1)[0]], [page(1)[0]]] }, "pagination-mismatch"],
    ["a 403", 403, "http-403"],
    ["a malformed body", { total: "many", pages: [[]] }, "malformed-response"],
  ])("marks a scope with %s as not collected", async (_label, route, reason) => {
    let staging = route;
    if (route === null) {
      let calls = 0;
      staging = { total: 0, pages: [] };
      Object.defineProperty(staging, "total", { get: () => (calls++ === 0 ? 101 : 102) });
      staging.pages = [page(100), page(1, 100)];
    }
    const api = githubApi({
      [`${base}/environments`]: environments(["production", "staging"]),
      [`${base}/actions/secrets`]: { total: 0, pages: [[]] },
      [`${base}/environments/production/secrets`]: { total: 0, pages: [[]] },
      [`${base}/environments/staging/secrets`]: staging,
    });
    const metadata = await collectSecretMetadata({
      inventory,
      repository: "chase-sets/chase-sets",
      token: "t",
      fetch: api.fetch,
    });
    expect(metadata.scopes.staging).toEqual({ status: "failed", reason });
    expect(classify(inventory, metadata, livenessOf()).status).toBe("warning");
  });

  it("still lists inventoried environments when discovery fails, and warns", async () => {
    const api = githubApi({
      [`${base}/environments`]: 500,
      [`${base}/actions/secrets`]: { total: 0, pages: [[]] },
      [`${base}/environments/production/secrets`]: {
        total: 1,
        pages: [[{ name: "STRIPE_KEY", updated_at: daysAgo(4) }]],
      },
      [`${base}/environments/staging/secrets`]: { total: 1, pages: [[{ name: "STRIPE_KEY", updated_at: daysAgo(4) }]] },
    });
    const metadata = await collectSecretMetadata({
      inventory,
      repository: "chase-sets/chase-sets",
      token: "t",
      fetch: api.fetch,
    });
    expect(metadata.environments).toEqual({ status: "failed", reason: "http-500" });
    expect(Object.keys(metadata.scopes)).toEqual(["repository", "production", "staging"]);
    const report = classify(inventory, metadata, livenessOf());
    expect(report.status).toBe("warning");
    expect(report.findings).toContainEqual({
      part: "metadata",
      scope: null,
      level: "warning",
      reason: "environments-not-discovered",
    });
  });

  it("withholds nothing silently: a pair missing its secret key is absent, and the report warns", async () => {
    const pair = inventoryOf([
      entry("SPACES_ACCESS_ID", { liveness: { kind: "spaces-list-buckets" }, pairedWith: ["SPACES_SECRET_KEY"] }),
      entry("SPACES_SECRET_KEY", { pairedWith: ["SPACES_ACCESS_ID"] }),
    ]);
    const row = await runLivenessRow({
      inventory: pair,
      scope: "staging",
      env: { SPACES_ACCESS_ID: `spaces-live-${SENTINEL}` },
      endpoints: endpoints(),
      now: NOW,
    });
    expect(row.results).toEqual([
      { name: "SPACES_ACCESS_ID", kind: "spaces-list-buckets", verdict: "absent", reason: "no-value" },
    ]);
    const report = classify(
      pair,
      metadataOf({
        staging: [
          ["SPACES_ACCESS_ID", daysAgo(3)],
          ["SPACES_SECRET_KEY", daysAgo(3)],
        ],
      }),
      { ...livenessOf(), staging: row },
    );
    expect(report.groups[0]).toMatchObject({ level: "warning", reasons: ["liveness-not-collected"] });
  });
});

// The workflow's structure is the guard for AC4's invariants: a read-only
// metadata token, each matrix row bound to its own environment, every secret
// exposed only to the rows its inventory scope names, and a report that runs
// and alerts even when collection fails.
const workflowPath = ".github/workflows/platform-credential-health.yml";
const repositoryInventory = validateCredentialInventory(
  JSON.parse(readFileSync(resolve(CREDENTIAL_INVENTORY_PATH), "utf8")),
).inventory;

function assertCredentialHealthWorkflow(workflow, inventory) {
  expect(workflow.permissions).toEqual({});
  expect(Object.keys(workflow.jobs).sort()).toEqual(["liveness", "metadata", "report"]);
  expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);

  const metadata = workflow.jobs.metadata;
  expect(metadata.environment).toBe("secret-rotation");
  expect(metadata.permissions).toEqual({ contents: "read" });
  const tokenStep = metadata.steps.find((step) => step.uses?.startsWith("actions/create-github-app-token@"));
  expect(tokenStep.uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}$/);
  expect(tokenStep.with).toEqual({
    "app-id": "${{ vars.CREDENTIAL_ROTATION_APP_ID }}",
    "private-key": "${{ secrets.CREDENTIAL_ROTATION_APP_PRIVATE_KEY }}",
    "permission-environments": "read",
    "permission-secrets": "read",
  });

  const liveness = workflow.jobs.liveness;
  expect(liveness.strategy["fail-fast"]).toBe(false);
  expect(liveness.strategy.matrix.scope).toEqual(inventory.scopes);
  expect(liveness.environment).toBe("${{ matrix.scope != 'repository' && matrix.scope || '' }}");
  expect(liveness.permissions).toEqual({ contents: "read" });
  const check = liveness.steps.find((step) => step.name === "Check credential liveness");
  expect(check.run).toContain("node ./scripts/credential-health.mjs liveness");
  const exposed = inventory.entries
    .filter((candidate) => candidate.liveness)
    .flatMap((candidate) =>
      SPACES_LIVENESS_KINDS.includes(candidate.liveness.kind)
        ? [candidate, inventory.byName.get(candidate.pairedWith[0])]
        : [candidate],
    );
  expect(check.env).toEqual({
    CREDENTIAL_SCOPE: "${{ matrix.scope }}",
    ...Object.fromEntries(
      exposed.map((candidate) => [
        candidate.name,
        `\${{ contains(fromJSON('${JSON.stringify(candidate.scope)}'), matrix.scope) && secrets.${candidate.name} || '' }}`,
      ]),
    ),
  });

  const report = workflow.jobs.report;
  expect(report.needs).toEqual(["metadata", "liveness"]);
  expect(report.if).toBe("${{ always() }}");
  expect(report.permissions).toEqual({ contents: "read", issues: "write" });
  expect(report.environment).toBeUndefined();
  expect(JSON.stringify(report)).not.toContain("secrets.");
  const classifyStep = report.steps.find((step) => step.id === "report");
  expect(classifyStep.env).toEqual({
    METADATA_RESULT: "${{ needs.metadata.result }}",
    LIVENESS_RESULT: "${{ needs.liveness.result }}",
  });
  const alert = report.steps.find((step) => step.uses === "./.github/actions/report-scheduled-workflow-alert");
  expect(alert.if).toBe("${{ always() }}");
  expect(alert.with).toMatchObject({
    "github-token": "${{ github.token }}",
    "workflow-name": workflow.name,
    "alert-status": "${{ steps.report.outputs.status || 'failure' }}",
  });
}

describe("platform credential health workflow (AC4)", () => {
  const workflow = parse(readFileSync(resolve(workflowPath), "utf8"));

  it("binds jobs, permissions and secrets to the inventory", () => {
    assertCredentialHealthWorkflow(workflow, repositoryInventory);
  });

  it.each([
    ["a secrets write permission", (mutant) => (mutant.jobs.metadata.steps[1].with["permission-secrets"] = "write")],
    ["an extra App permission", (mutant) => (mutant.jobs.metadata.steps[1].with["permission-actions"] = "read")],
    ["a write GITHUB_TOKEN on metadata", (mutant) => (mutant.jobs.metadata.permissions.actions = "write")],
    ["a dropped environment row", (mutant) => mutant.jobs.liveness.strategy.matrix.scope.pop()],
    [
      "a secret exposed to every row",
      (mutant) => (mutant.jobs.liveness.steps[1].env.PROJECTS_TOKEN = "${{ secrets.PROJECTS_TOKEN }}"),
    ],
    ["a report gated on success", (mutant) => delete mutant.jobs.report.if],
    [
      "an alert that defaults to success",
      (mutant) =>
        (mutant.jobs.report.steps.at(-2).with["alert-status"] = "${{ steps.report.outputs.status || 'success' }}"),
    ],
  ])("rejects %s", (_label, mutate) => {
    const mutant = structuredClone(workflow);
    mutate(mutant);
    expect(() => assertCredentialHealthWorkflow(mutant, repositoryInventory)).toThrow();
  });

  it("is registered as a ci workflow and an ops subcommand", () => {
    expect(releaseQualificationScopeRegistry.workflows["platform-credential-health.yml"]).toBe("ci");
    expect(SUBCOMMANDS["credential:health"].script).toBe("credential-health.mjs");
  });
});
