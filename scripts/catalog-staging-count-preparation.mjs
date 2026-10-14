import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  acquireRehearsalCounts,
  admitRehearsalCountAcquisition,
  createRehearsalCountAdminClient,
  quoteRehearsalCounts,
} from "../bounded-contexts/catalog/features/scope-sync-batches/api/rehearsal-count-preparation.ts";
import {
  parseRehearsalCountPreparationDispatchId,
  parseRehearsalCountPreparationPass,
  rehearsalCountPreparationCredentialNames,
  rehearsalCountPreparationReceiptPath,
  rehearsalCountPreparationContinuation,
  rehearsalCountPreparationStagingOrigin,
  validateRehearsalCountPreparationReceiptText,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/rehearsal-count-preparation-receipt.ts";

// Thin staging runner for governed Scrydex count preparation. The
// workflow admits the immutable SHA and exact staging origin before this job
// receives the Admin credential; this runner signs in over the shipped password
// route (no browser, so no trace, video, HAR, storage state or screenshot),
// drives only the Catalog preparation module through an origin-fenced fetch and
// writes one validated receipt. It never holds provider credentials. Output
// names outcomes and refusal codes, never values. Runs under tsx because the
// preparation module is Catalog TypeScript.

const origin = rehearsalCountPreparationStagingOrigin;
const providerCredentialNames = ["SCRYDEX_API_KEY", "SCRYDEX_TEAM_ID"];

export class CountPreparationRunnerRefusal extends Error {
  constructor(code) {
    super(`Count preparation runner refused: ${code}.`);
    this.name = "CountPreparationRunnerRefusal";
    this.code = code;
  }
}

const refuse = (code) => new CountPreparationRunnerRefusal(code);

export function countPreparationIdentity(env) {
  if (env.GITHUB_ACTIONS !== "true") throw refuse("github-actions-required");
  if (env.ADMIN_WEB_URL !== origin) throw refuse("staging-origin-required");
  const sha = env.GITHUB_SHA ?? "";
  if (!/^[a-f0-9]{40}$/.test(sha) || (env.EXPECTED_SHA ?? "").trim().toLowerCase() !== sha)
    throw refuse("expected-sha-mismatch");
  const runId = env.GITHUB_RUN_ID ?? "";
  const runAttempt = env.GITHUB_RUN_ATTEMPT ?? "";
  if (!/^\d{1,20}$/.test(runId) || !/^\d{1,6}$/.test(runAttempt)) throw refuse("run-identity-invalid");
  return { sha, runId, runAttempt };
}

/** Parses and admits every dispatch input before any credential is read or request is sent. */
export function countPreparationInput(env, now) {
  const mode = env.CATALOG_COUNT_PREPARATION_MODE;
  if (mode !== "quote" && mode !== "acquire") throw refuse("mode-invalid");
  const pass = parseRehearsalCountPreparationPass({
    passNumber: env.CATALOG_COUNT_PREPARATION_PASS,
    productDomain: env.CATALOG_COUNT_PREPARATION_PRODUCT_DOMAIN,
    languageCode: env.CATALOG_COUNT_PREPARATION_LANGUAGE_CODE,
  });
  const dispatchId = parseRehearsalCountPreparationDispatchId(env.CATALOG_COUNT_PREPARATION_DISPATCH_ID);
  const cap = (env.CATALOG_COUNT_PREPARATION_CAP ?? "").trim();
  const approval = (env.CATALOG_COUNT_PREPARATION_APPROVAL ?? "").trim();
  if (mode === "quote") {
    if (approval) throw refuse("approval-not-allowed-in-quote-mode");
    if (cap && !/^\d{1,5}$/.test(cap)) throw refuse("cap-invalid");
    return { mode, pass, dispatchId, cap: cap ? Number(cap) : undefined };
  }
  if (cap) throw refuse("cap-not-allowed-in-acquire-mode");
  return { mode, pass, dispatchId, approval: admitRehearsalCountAcquisition({ approval, pass, dispatchId, now }) };
}

function adminCredentials(env) {
  const missing = rehearsalCountPreparationCredentialNames.filter((name) => !(env[name] ?? "").trim());
  if (missing.length > 0) throw refuse(`admin-credential-missing:${missing.join(",")}`);
  if (providerCredentialNames.some((name) => (env[name] ?? "").trim())) throw refuse("provider-credential-present");
  return { email: env.CATALOG_ADMIN_E2E_EMAIL.trim(), password: env.CATALOG_ADMIN_E2E_PASSWORD };
}

/** Every request stays on the exact staging origin and never follows a redirect. */
export function stagingOriginFetch(fetchImpl) {
  return (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== origin || url.username || url.password) throw refuse("staging-origin-required");
    return fetchImpl(url.toString(), { ...init, redirect: "manual" });
  };
}

export async function signInStagingAdmin({ email, password, fetch }) {
  const response = await fetch(`${origin}/api/auth/password-sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw refuse(`admin-sign-in-failed:${response.status}`);
  }
  let token;
  try {
    token = (await response.json())?.sessionToken;
  } catch {
    token = undefined;
  }
  if (typeof token !== "string" || !/^[^\s;,]{16,4096}$/.test(token)) throw refuse("admin-sign-in-token-missing");
  return token;
}

export function summarizeCountPreparation(receipt) {
  const debits = receipt.accounting?.debits ?? [];
  return {
    mode: receipt.mode,
    outcome: receipt.outcome,
    refusal: receipt.refusal,
    continuation: rehearsalCountPreparationContinuation(receipt),
    pass: receipt.pass,
    quote: receipt.quote,
    authority: receipt.authority,
    reused: receipt.roster.filter((entry) => entry.state === "reused").length,
    blocked: receipt.roster.filter((entry) => entry.state === "blocked").length,
    sources: receipt.sources.length,
    // Unknown accounting is reported as unknown, never as zero spend.
    accounting: receipt.accounting && {
      status: receipt.accounting.status,
      reason: receipt.accounting.reason,
      debits: debits.length,
      outcomes: Object.fromEntries(
        ["complete", "failed", "uncertain", "acquiring"]
          .map((outcome) => [outcome, debits.filter((debit) => debit.outcome === outcome).length])
          .filter(([, count]) => count > 0),
      ),
    },
    readback: receipt.acquisition?.readback ?? null,
  };
}

export async function runCountPreparation({
  env = process.env,
  fetch = globalThis.fetch,
  now = () => new Date().toISOString(),
  receiptPath = rehearsalCountPreparationReceiptPath,
} = {}) {
  const run = countPreparationIdentity(env);
  const input = countPreparationInput(env, now());
  const { email, password } = adminCredentials(env);
  const fenced = stagingOriginFetch(fetch);
  const token = await signInStagingAdmin({ email, password, fetch: fenced });
  const admin = createRehearsalCountAdminClient({ origin, cookie: `chase_sets_session=${token}`, fetch: fenced });
  const receipt =
    input.mode === "quote"
      ? await quoteRehearsalCounts({ admin, run, dispatchId: input.dispatchId, pass: input.pass, cap: input.cap, now })
      : await acquireRehearsalCounts({ admin, run, approval: input.approval, now });
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  const verdict = validateRehearsalCountPreparationReceiptText(text, {
    ...run,
    forbiddenValues: [email, password, token],
  });
  if (!verdict.ok) throw refuse(`receipt-invalid:${verdict.errors.slice(0, 5).join("|")}`);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, text);
  // A quote awaiting approval or a validated handoff ends successfully; every stop fails the run.
  return { ok: rehearsalCountPreparationContinuation(receipt) !== "stop", summary: summarizeCountPreparation(receipt) };
}

/** Pre-upload gate: the exact regular receipt file, bound to this run, free of admitted credential values. */
export function validateCountPreparationFile({ file = rehearsalCountPreparationReceiptPath, env = process.env } = {}) {
  let text;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink())
      return { ok: false, errors: ["receipt-not-regular-file"], summary: null };
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, errors: ["receipt-missing"], summary: null };
  }
  const inActions = env.GITHUB_ACTIONS === "true";
  const missingIdentity = inActions
    ? ["GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"].filter((name) => !env[name])
    : [];
  const verdict = validateRehearsalCountPreparationReceiptText(text, {
    sha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    forbiddenValues: rehearsalCountPreparationCredentialNames.map((name) => env[name] ?? "").filter(Boolean),
  });
  const errors = [...missingIdentity.map((name) => `${name}-required`), ...verdict.errors];
  return {
    ok: errors.length === 0,
    errors,
    summary: verdict.receipt ? summarizeCountPreparation(verdict.receipt) : null,
  };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "run") {
    try {
      const result = await runCountPreparation();
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : (error?.name ?? "count-preparation-failed");
      console.error(JSON.stringify({ ok: false, refusal: code }));
      process.exitCode = 1;
    }
  } else if (command === "validate") {
    const result = validateCountPreparationFile({ file: option(rest, "--file") });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else {
    console.error("Usage: tsx scripts/catalog-staging-count-preparation.mjs run | validate [--file <receipt.json>]");
    process.exitCode = 2;
  }
}
