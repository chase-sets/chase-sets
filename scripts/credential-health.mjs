#!/usr/bin/env node
// Daily platform credential health: secret metadata (names and update dates),
// in-process liveness checks, and the level classifier. Levels and terms are
// defined in docs/runbooks/credential-rotation.md.
//
// Secret values enter only `checkCredentialLiveness` and the request it signs.
// Every output — liveness rows, reports, summaries, alert text — carries only
// names, scopes, ages, expiry dates, verdicts and a closed reason vocabulary,
// never a value, a response body or an exception message.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { REPOSITORY_SCOPE, SPACES_LIVENESS_KINDS, loadCredentialInventory } from "./credential-inventory.mjs";

export const LEVELS = Object.freeze(["success", "warning", "failure"]);
export const DEFAULT_ENDPOINTS = Object.freeze({
  digitalocean: "https://api.digitalocean.com",
  spaces: "https://nyc3.digitaloceanspaces.com",
  github: "https://api.github.com",
});
const SPACES_REGION = "nyc3";
const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;
const SPACES_ERROR_CODES = new Map([
  ["InvalidAccessKeyId", { verdict: "dead", reason: "invalid-access-key-id" }],
  ["SignatureDoesNotMatch", { verdict: "unknown", reason: "signature-does-not-match" }],
  ["AccessDenied", { verdict: "unknown", reason: "access-denied" }],
]);
const GITHUB_EXPIRATION_HEADER = "github-authentication-token-expiration";
const GITHUB_EXPIRATION = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (UTC|[+-]\d{4})$/;

function maxLevel(levels) {
  return levels.reduce((worst, level) => (LEVELS.indexOf(level) > LEVELS.indexOf(worst) ? level : worst), "success");
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

// AWS Signature Version 4 for a bodiless request, following the published
// algorithm. `headers` are extra headers to sign (lower-case names).
export function signAwsV4Request({
  method = "GET",
  url,
  region,
  service,
  accessKeyId,
  secretAccessKey,
  headers = {},
  payloadHash = EMPTY_PAYLOAD_SHA256,
  now = new Date(),
}) {
  const target = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const signed = { ...headers, host: target.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(signed)
    .map((name) => name.toLowerCase())
    .sort();
  const lowered = Object.fromEntries(Object.entries(signed).map(([name, value]) => [name.toLowerCase(), value]));
  const canonicalHeaders = names.map((name) => `${name}:${String(lowered[name]).trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = [...target.searchParams]
    .map(([key, value]) => [rfc3986(key), rfc3986(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? (leftValue < rightValue ? -1 : 1) : leftKey < rightKey ? -1 : 1,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalRequest = [method, target.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join(
    "\n",
  );
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const signingKey = hmac(hmac(hmac(dateKey, region), service), "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  // fetch derives Host from the URL; it is signed but never sent explicitly.
  const sendHeaders = Object.fromEntries(Object.entries(lowered).filter(([name]) => name !== "host"));
  return {
    signature,
    headers: {
      ...sendHeaders,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

// Strict `YYYY-MM-DD HH:MM:SS (UTC|±HHMM)`; returns epoch ms or null.
export function parseGitHubTokenExpiration(value) {
  const match = GITHUB_EXPIRATION.exec(String(value ?? "").trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const zone = match[7];
  const offsetMinutes =
    zone === "UTC" ? 0 : (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  if (zone !== "UTC" && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(3, 5)) > 59)) return null;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  if (new Date(local).getUTCDate() !== day) return null;
  return local - offsetMinutes * 60_000;
}

async function request(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

function statusVerdict(response, { live, dead }) {
  if (!response) return { verdict: "unknown", reason: "network-error" };
  if (live(response.status)) return { verdict: "live", reason: `http-${response.status}` };
  if (dead(response.status)) return { verdict: "dead", reason: `http-${response.status}` };
  return { verdict: "unknown", reason: response.status >= 500 ? "http-5xx" : `http-${response.status}` };
}

async function spacesErrorCode(response) {
  try {
    const text = (await response.text()).slice(0, 4096);
    return /<Code>([A-Za-z]{1,64})<\/Code>/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

// One liveness check per credential, in process. `credentials` is
// `{ token }` for token kinds and `{ accessKeyId, secretAccessKey, bucket? }`
// for Spaces kinds. An empty value is "absent", never dead.
export async function checkCredentialLiveness(kind, credentials, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
  const now = options.now ?? new Date();
  if (kind === "digitalocean-account") {
    if (!credentials?.token) return { verdict: "absent", reason: "no-value" };
    const response = await request(fetchImpl, `${endpoints.digitalocean}/v2/account`, {
      headers: { authorization: `Bearer ${credentials.token}`, accept: "application/json" },
    });
    return statusVerdict(response, { live: (status) => status === 200, dead: (status) => status === 401 });
  }
  if (kind === "github-token") {
    if (!credentials?.token) return { verdict: "absent", reason: "no-value" };
    const response = await request(fetchImpl, `${endpoints.github}/user`, {
      headers: {
        authorization: `Bearer ${credentials.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "chase-sets-credential-health",
        "x-github-api-version": "2022-11-28",
      },
    });
    const result = statusVerdict(response, { live: (status) => status === 200, dead: (status) => status === 401 });
    if (result.verdict !== "live") return result;
    const header = response.headers.get(GITHUB_EXPIRATION_HEADER);
    if (header === null) return { ...result, expiryMeasured: true, providerExpiresAt: null };
    const expiresAt = parseGitHubTokenExpiration(header);
    if (expiresAt === null) return { verdict: "unknown", reason: "expiry-header-malformed" };
    const responseDate = Date.parse(response.headers.get("date") ?? "");
    if (!Number.isFinite(responseDate)) return { verdict: "unknown", reason: "response-date-missing" };
    if (expiresAt <= responseDate + HOUR_MS) return { verdict: "unknown", reason: "expiry-not-after-response-date" };
    return { ...result, expiryMeasured: true, providerExpiresAt: new Date(expiresAt).toISOString() };
  }
  if (SPACES_LIVENESS_KINDS.includes(kind)) {
    if (!credentials?.accessKeyId || !credentials?.secretAccessKey) return { verdict: "absent", reason: "no-value" };
    const url =
      kind === "spaces-bucket"
        ? `${endpoints.spaces}/${encodeURIComponent(credentials.bucket)}?list-type=2&max-keys=0`
        : `${endpoints.spaces}/`;
    const signed = signAwsV4Request({
      url,
      region: SPACES_REGION,
      service: "s3",
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      now,
    });
    const response = await request(fetchImpl, url, { headers: signed.headers });
    if (!response) return { verdict: "unknown", reason: "network-error" };
    if (response.status >= 200 && response.status < 300) return { verdict: "live", reason: `http-${response.status}` };
    if (response.status >= 400 && response.status < 500) {
      const mapped = SPACES_ERROR_CODES.get(await spacesErrorCode(response));
      return mapped ?? { verdict: "unknown", reason: "http-4xx" };
    }
    return { verdict: "unknown", reason: response.status >= 500 ? "http-5xx" : `http-${response.status}` };
  }
  return { verdict: "unknown", reason: "unsupported-kind" };
}

// Liveness for one matrix row: only entries whose scope includes the row are
// read from `env`; everything else stays untouched.
export async function runLivenessRow({ inventory, scope, env = process.env, ...options }) {
  const results = [];
  for (const entry of inventory.entries) {
    if (!entry.liveness || !entry.scope.includes(scope)) continue;
    const { kind, bucket } = entry.liveness;
    const credentials = SPACES_LIVENESS_KINDS.includes(kind)
      ? { accessKeyId: env[entry.name], secretAccessKey: env[entry.pairedWith[0]], bucket }
      : { token: env[entry.name] };
    results.push({ name: entry.name, kind, ...(await checkCredentialLiveness(kind, credentials, options)) });
  }
  return {
    schemaVersion: "credential-liveness/v1",
    scope,
    checkedAt: (options.now ?? new Date()).toISOString(),
    results,
  };
}

async function listPaginated(fetchImpl, url, token, itemsKey) {
  const items = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await request(fetchImpl, `${url}?per_page=100&page=${page}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "chase-sets-credential-health",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response) return { status: "failed", reason: "network-error" };
    if (response.status !== 200) return { status: "failed", reason: `http-${response.status}` };
    let body;
    try {
      body = await response.json();
    } catch {
      return { status: "failed", reason: "malformed-response" };
    }
    if (!Number.isInteger(body?.total_count) || !Array.isArray(body?.[itemsKey])) {
      return { status: "failed", reason: "malformed-response" };
    }
    if (total !== null && body.total_count !== total) return { status: "failed", reason: "pagination-mismatch" };
    total = body.total_count;
    items.push(...body[itemsKey]);
    if (items.length >= total || body[itemsKey].length === 0) break;
  }
  const names = new Set(items.map((item) => item?.name));
  if (items.length !== total || names.size !== total || [...names].some((name) => typeof name !== "string")) {
    return { status: "failed", reason: "pagination-mismatch" };
  }
  return { status: "collected", items };
}

// Lists secret names and update dates for the repository and every
// environment (inventoried or discovered). Totals are reconciled against the
// API's `total_count`; any shortfall marks that scope as not collected.
export async function collectSecretMetadata({
  inventory,
  repository,
  token,
  fetch: fetchImpl = globalThis.fetch,
  apiUrl,
}) {
  const base = `${apiUrl ?? DEFAULT_ENDPOINTS.github}/repos/${repository}`;
  const discovery = await listPaginated(fetchImpl, `${base}/environments`, token, "environments");
  const discovered = discovery.status === "collected" ? discovery.items.map((item) => item.name) : [];
  const environments = [...new Set([...inventory.environments, ...discovered])].sort();
  const scopes = {};
  for (const scope of [REPOSITORY_SCOPE, ...environments]) {
    const url =
      scope === REPOSITORY_SCOPE
        ? `${base}/actions/secrets`
        : `${base}/environments/${encodeURIComponent(scope)}/secrets`;
    const listed = await listPaginated(fetchImpl, url, token, "secrets");
    scopes[scope] =
      listed.status === "collected"
        ? {
            status: "collected",
            secrets: listed.items
              .map((item) => ({ name: item.name, updatedAt: item.updated_at ?? null }))
              .sort((left, right) => left.name.localeCompare(right.name)),
          }
        : { status: "failed", reason: listed.reason };
  }
  return {
    schemaVersion: "credential-metadata/v1",
    collectedAt: new Date().toISOString(),
    environments:
      discovery.status === "collected"
        ? { status: "collected", names: discovered.sort() }
        : { status: "failed", reason: discovery.reason },
    scopes,
  };
}

function isoDate(ms) {
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

function ageReasons(entry, ageDays, remainingDays) {
  const reasons = [];
  const max = entry.maxAgeDays;
  if (entry.rotation === "automatic") {
    if (ageDays > max + 14) reasons.push(["failure", "older-than-max-age-plus-14"]);
    else if (ageDays > max + 7) reasons.push(["warning", "older-than-max-age-plus-7"]);
    if (remainingDays !== null && remainingDays <= 7) reasons.push(["failure", "provider-expiry-within-7-days"]);
    return reasons;
  }
  if (remainingDays !== null && remainingDays <= 7) reasons.push(["failure", "provider-expiry-within-7-days"]);
  else if (remainingDays !== null && remainingDays <= 21) reasons.push(["warning", "provider-expiry-within-21-days"]);
  if (ageDays > max) reasons.push(["failure", "older-than-max-age"]);
  else if (max - ageDays <= 30) reasons.push(["warning", "max-age-within-30-days"]);
  return reasons;
}

const LIVENESS_LEVELS = { live: null, dead: "failure", unknown: "warning", absent: "warning" };

// The level classifier (runbook "Levels"). `metadata` is a collectSecretMetadata document (or null),
// `liveness` maps scope -> runLivenessRow document, and `jobResults` carries
// the producing jobs' results when known. A failed or absent collection is a
// warning; it never reports success.
export function classifyCredentialHealth({
  inventory,
  metadata = null,
  liveness = {},
  jobResults = {},
  now = new Date(),
}) {
  const nowMs = now.getTime();
  const findings = [];
  for (const part of ["metadata", "liveness"]) {
    if (part in jobResults && jobResults[part] !== "success") {
      findings.push({ part, scope: null, level: "warning", reason: `${part}-job-${jobResults[part] || "missing"}` });
    }
  }
  if (metadata?.environments?.status !== "collected") {
    findings.push({ part: "metadata", scope: null, level: "warning", reason: "environments-not-discovered" });
  }
  const scopes = [
    ...new Set([
      ...inventory.scopes,
      ...Object.keys(metadata?.scopes ?? {}).filter((scope) => scope !== REPOSITORY_SCOPE),
    ]),
  ];
  const listed = new Map();
  for (const scope of scopes) {
    const record = metadata?.scopes?.[scope];
    if (record?.status === "collected" && Array.isArray(record.secrets)) {
      listed.set(scope, new Map(record.secrets.map((secret) => [secret.name, Date.parse(secret.updatedAt ?? "")])));
    } else {
      findings.push({ part: "metadata", scope, level: "warning", reason: "metadata-not-collected" });
    }
    const row = liveness[scope];
    if (row?.schemaVersion !== "credential-liveness/v1" || row.scope !== scope || !Array.isArray(row.results)) {
      if (inventory.scopes.includes(scope)) {
        findings.push({ part: "liveness", scope, level: "warning", reason: "liveness-not-collected" });
      }
    }
  }

  const groups = [];
  const table = [];
  for (const entry of inventory.entries) {
    for (const group of entry.valueGroups) {
      const reasons = [];
      const present = [];
      const livenessByScope = {};
      const measured = [];
      for (const scope of group) {
        const names = listed.get(scope);
        if (!names) {
          reasons.push(["warning", "metadata-not-collected"]);
          continue;
        }
        if (!names.has(entry.name)) {
          if (!entry.optional) reasons.push(["warning", "missing-from-scope"]);
          continue;
        }
        const updatedAt = names.get(entry.name);
        if (!Number.isFinite(updatedAt)) {
          reasons.push(["warning", "metadata-not-collected"]);
          continue;
        }
        present.push({ scope, updatedAt });
        if (!entry.liveness) continue;
        const row = liveness[scope];
        const result = row?.scope === scope ? row.results?.find((candidate) => candidate.name === entry.name) : null;
        const verdict = result?.verdict ?? "not-collected";
        livenessByScope[scope] = verdict;
        if (!result || !(verdict in LIVENESS_LEVELS)) reasons.push(["warning", "liveness-not-collected"]);
        else if (verdict === "absent") reasons.push(["warning", "liveness-not-collected"]);
        else if (LIVENESS_LEVELS[verdict]) reasons.push([LIVENESS_LEVELS[verdict], `liveness-${verdict}`]);
        if (result?.expiryMeasured)
          measured.push(result.providerExpiresAt ? Date.parse(result.providerExpiresAt) : null);
      }
      let oldest = null;
      let ageDays = null;
      let providerExpiresAt = null;
      if (present.length > 0) {
        oldest = Math.min(...present.map(({ updatedAt }) => updatedAt));
        ageDays = (nowMs - oldest) / DAY_MS;
        const measuredExpiries = measured.filter((value) => Number.isFinite(value));
        providerExpiresAt =
          measured.length > 0
            ? measuredExpiries.length > 0
              ? Math.min(...measuredExpiries)
              : null
            : entry.providerExpiryDays
              ? oldest + entry.providerExpiryDays * DAY_MS
              : null;
        if (entry.kind === "credential") {
          const remainingDays = providerExpiresAt === null ? null : (providerExpiresAt - nowMs) / DAY_MS;
          reasons.push(...ageReasons(entry, ageDays, remainingDays));
        }
      }
      const level = maxLevel(reasons.map(([reasonLevel]) => reasonLevel));
      const verdict = {
        name: entry.name,
        scopes: group,
        kind: entry.kind,
        rotation: entry.rotation,
        optional: entry.optional,
        level,
        updatedAt: isoDate(oldest),
        ageDays: ageDays === null ? null : Math.floor(ageDays),
        providerExpiresAt: isoDate(providerExpiresAt),
        liveness: livenessByScope,
        reasons: [...new Set(reasons.map(([, reason]) => reason))],
      };
      groups.push(verdict);
      for (const scope of group) {
        const updatedAt = listed.get(scope)?.get(entry.name);
        table.push({
          scope,
          name: entry.name,
          inventory: `${entry.kind}, ${entry.rotation}${entry.optional ? ", optional" : ""}`,
          state: !listed.has(scope) ? "unknown" : listed.get(scope).has(entry.name) ? "set" : "unset",
          updatedAt: Number.isFinite(updatedAt) ? isoDate(updatedAt) : null,
          ageDays: verdict.ageDays,
          providerExpiresAt: verdict.providerExpiresAt,
          liveness: livenessByScope[scope] ?? null,
          level,
          reasons: verdict.reasons,
        });
      }
    }
  }
  for (const [scope, names] of listed) {
    for (const [name, updatedAt] of names) {
      if (inventory.byName.get(name)?.scope.includes(scope)) continue;
      const row = {
        scope,
        name,
        inventory: "not inventoried",
        state: "set",
        updatedAt: Number.isFinite(updatedAt) ? isoDate(updatedAt) : null,
        ageDays: Number.isFinite(updatedAt) ? Math.floor((nowMs - updatedAt) / DAY_MS) : null,
        providerExpiresAt: null,
        liveness: null,
        level: "warning",
        reasons: ["not-inventoried"],
      };
      table.push(row);
      groups.push({
        name,
        scopes: [scope],
        kind: null,
        rotation: null,
        optional: false,
        level: "warning",
        updatedAt: row.updatedAt,
        ageDays: row.ageDays,
        providerExpiresAt: null,
        liveness: {},
        reasons: ["not-inventoried"],
      });
    }
  }
  table.sort(
    (left, right) => scopes.indexOf(left.scope) - scopes.indexOf(right.scope) || left.name.localeCompare(right.name),
  );
  const status = maxLevel([...groups.map(({ level }) => level), ...findings.map(({ level }) => level)]);
  const counts = Object.fromEntries(
    LEVELS.map((level) => [level, groups.filter((group) => group.level === level).length]),
  );
  return {
    schemaVersion: "credential-health/v1",
    generatedAt: now.toISOString(),
    status,
    counts,
    scopes,
    findings,
    groups,
    table,
  };
}

function cell(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

export function renderCredentialHealthSummary(report) {
  const lines = [
    "## Platform credential health",
    "",
    `- Status: ${report.status}`,
    `- Generated: ${report.generatedAt}`,
    `- Value groups: ${report.counts.failure} failure, ${report.counts.warning} warning, ${report.counts.success} success`,
  ];
  for (const finding of report.findings) {
    lines.push(
      `- Collection ${finding.level}: ${finding.part}${finding.scope ? ` (${finding.scope})` : ""} ${finding.reason}`,
    );
  }
  for (const scope of report.scopes) {
    const rows = report.table.filter((row) => row.scope === scope && row.state !== "unset");
    const unset = report.table.filter((row) => row.scope === scope && row.state === "unset");
    lines.push("", `### ${scope}`, "");
    lines.push("| Name | Inventory | Updated | Age (days) | Provider expiry | Liveness | Level | Reasons |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const row of rows) {
      lines.push(
        `| ${row.name} | ${row.inventory} | ${cell(row.updatedAt)} | ${cell(row.ageDays)} | ${cell(row.providerExpiresAt)} | ${cell(row.liveness)} | ${row.level} | ${cell(row.reasons.join(", "))} |`,
      );
    }
    for (const row of unset.filter((candidate) => candidate.level !== "success")) {
      lines.push(
        `| ${row.name} | ${row.inventory} | unset | — | — | — | ${row.level} | ${cell(row.reasons.join(", "))} |`,
      );
    }
    const optionalUnset = unset.filter((row) => row.level === "success");
    if (optionalUnset.length > 0) {
      lines.push("", `Unset optional names: ${optionalUnset.map((row) => row.name).join(", ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function credentialHealthAlert(report, { maxLines = 30 } = {}) {
  const summary = `Credential health ${report.status}: ${report.counts.failure} failure and ${report.counts.warning} warning value groups; ${report.findings.length} collection findings.`;
  const lines = [
    ...report.findings.map(
      (finding) => `- ${finding.level}: ${finding.part}${finding.scope ? ` (${finding.scope})` : ""} ${finding.reason}`,
    ),
    ...report.groups
      .filter((group) => group.level !== "success")
      .sort(
        (left, right) =>
          LEVELS.indexOf(right.level) - LEVELS.indexOf(left.level) || left.name.localeCompare(right.name),
      )
      .map(
        (group) =>
          `- ${group.level}: ${group.name} (${group.scopes.join(", ")}) ${group.reasons.join(", ")}; age ${cell(group.ageDays)} d; provider expiry ${cell(group.providerExpiresAt)}`,
      ),
  ];
  const details =
    lines.length > maxLines
      ? [...lines.slice(0, maxLines), `- … ${lines.length - maxLines} more in the run summary`].join("\n")
      : lines.join("\n");
  return { status: report.status, summary, details };
}

function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Errors whose message is safe to print: argument and inventory problems name
// only options and secret names.
class UsageError extends Error {}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function required(argv, name) {
  const value = option(argv, name);
  if (!value) throw new UsageError(`${name} is required`);
  return value;
}

export async function main(argv, env = process.env) {
  const [command, ...args] = argv;
  let inventory;
  try {
    inventory = loadCredentialInventory(option(args, "--repository-root") ?? process.cwd());
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (command === "metadata") {
    const token = env.GH_TOKEN;
    if (!token) throw new UsageError("GH_TOKEN is required for metadata collection");
    const metadata = await collectSecretMetadata({ inventory, repository: required(args, "--repository"), token });
    writeJson(required(args, "--out"), metadata);
    return 0;
  }
  if (command === "liveness") {
    const scope = required(args, "--scope");
    if (!inventory.scopes.includes(scope)) throw new UsageError("--scope must be an inventoried scope");
    writeJson(required(args, "--out"), await runLivenessRow({ inventory, scope, env }));
    return 0;
  }
  if (command === "report") {
    const livenessDirectory = required(args, "--liveness-dir");
    const liveness = Object.fromEntries(
      inventory.scopes.map((scope) => [scope, readJsonIfPresent(join(livenessDirectory, `liveness-${scope}.json`))]),
    );
    const jobResults = {};
    if (option(args, "--metadata-result") !== undefined) jobResults.metadata = option(args, "--metadata-result");
    if (option(args, "--liveness-result") !== undefined) jobResults.liveness = option(args, "--liveness-result");
    const report = classifyCredentialHealth({
      inventory,
      metadata: readJsonIfPresent(required(args, "--metadata")),
      liveness,
      jobResults,
    });
    writeJson(required(args, "--out"), report);
    const summary = option(args, "--summary");
    if (summary) appendFileSync(summary, renderCredentialHealthSummary(report));
    const githubOutput = option(args, "--github-output");
    if (githubOutput) {
      const alert = credentialHealthAlert(report);
      const delimiter = `CREDENTIAL_HEALTH_${randomUUID().replaceAll("-", "")}`;
      appendFileSync(
        githubOutput,
        `status=${alert.status}\nsummary=${alert.summary}\ndetails<<${delimiter}\n${alert.details}\n${delimiter}\n`,
      );
    }
    process.stdout.write(`${credentialHealthAlert(report).summary}\n`);
    return 0;
  }
  throw new UsageError("usage: credential-health.mjs <metadata|liveness|report> [options]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // Provider failures are verdicts, so anything else is a bounded class.
      const message = error instanceof UsageError ? error.message : `failed (${error?.name ?? "Error"})`;
      process.stderr.write(`credential-health: ${message}\n`);
      process.exitCode = 1;
    });
}
